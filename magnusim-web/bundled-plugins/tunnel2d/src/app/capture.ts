// Capture: a picture (PNG) or a recording (WebM) of the view as it is drawn, the flow and
// everything over it, with its colour legend and a line saying what it shows. Each is drawn
// right after the engine submits a frame (so the GPU canvas is read while its picture is the
// current one) and downloads from the page.
// SPDX-License-Identifier: GPL-3.0-or-later
import type { Engine } from '../sim/engine';

export interface LegendSpec {
  title: string;
  unit: string;
  lo: number;
  hi: number;
  /** The map's 256 colours (RGB). */
  rgb: Uint8Array;
}

type Listener = () => void;

const fmt = new Intl.NumberFormat('en-US', { maximumSignificantDigits: 3 });

/** A file name with the date and time: tunnel-2026-10-14-1530-12.png. */
export function captureName(ext: string, now = new Date()): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `tunnel-${now.getFullYear()}-${p(now.getMonth() + 1)}-${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}-${p(now.getSeconds())}.${ext}`;
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export class Capture {
  /** The recording on now: since when (performance.now()). */
  recording: { since: number } | null = null;
  version = 0;
  private engine: Engine;
  private legend: () => LegendSpec | null;
  private caption: () => string;
  private canvas = document.createElement('canvas');
  private recorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private pending: ((c: HTMLCanvasElement) => void)[] = [];
  private listeners = new Set<Listener>();

  constructor(engine: Engine, legend: () => LegendSpec | null, caption: () => string) {
    this.engine = engine;
    this.legend = legend;
    this.caption = caption;
    engine.afterFrame = () => this.onFrame();
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit() {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Whether this browser can record the view (MediaRecorder with WebM). */
  get canRecord(): boolean {
    return typeof MediaRecorder !== 'undefined' && typeof this.canvas.captureStream === 'function' && (MediaRecorder.isTypeSupported('video/webm;codecs=vp9') || MediaRecorder.isTypeSupported('video/webm'));
  }

  private onFrame() {
    if (!this.recording && !this.pending.length) return;
    const c = this.compose();
    const waiting = this.pending;
    this.pending = [];
    for (const fn of waiting) fn(c);
  }

  /** The view now, into the capture canvas: the flow, the overlay, the legend and the caption. */
  private compose(): HTMLCanvasElement {
    const src = this.engine.canvas;
    const w = src.width;
    const h = src.height;
    const c = this.canvas;
    if (c.width !== w || c.height !== h) {
      c.width = w;
      c.height = h;
    }
    const g = c.getContext('2d')!;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.drawImage(src, 0, 0);
    const overlay = document.querySelector<HTMLCanvasElement>('[data-t2d-viewport] canvas.t2d-overlay');
    if (overlay && overlay.width === w && overlay.height === h) g.drawImage(overlay, 0, 0);
    const dpr = this.engine.worldView.dpr || 1;
    g.scale(dpr, dpr);
    const W = w / dpr;
    const H = h / dpr;
    const css = getComputedStyle(document.documentElement);
    const bg = css.getPropertyValue('--mg-bg').trim() || 'white';
    const ink = css.getPropertyValue('--mg-text').trim() || 'black';
    g.font = '12px system-ui, sans-serif';
    g.textBaseline = 'middle';
    const lg = this.legend();
    if (lg) {
      const x = 12;
      const y = H - 58;
      g.globalAlpha = 0.9;
      g.fillStyle = bg;
      g.fillRect(x, y, 230, 50);
      g.globalAlpha = 1;
      g.fillStyle = ink;
      g.textAlign = 'left';
      g.fillText(lg.unit ? `${lg.title} (${lg.unit})` : lg.title, x + 8, y + 11);
      for (let i = 0; i < 214; i++) {
        const j = Math.round((i / 213) * 255);
        g.fillStyle = `rgb(${lg.rgb[3 * j]}, ${lg.rgb[3 * j + 1]}, ${lg.rgb[3 * j + 2]})`;
        g.fillRect(x + 8 + i, y + 20, 1.5, 10);
      }
      g.fillStyle = ink;
      g.fillText(fmt.format(lg.lo), x + 8, y + 41);
      g.textAlign = 'right';
      g.fillText(fmt.format(lg.hi), x + 222, y + 41);
      g.textAlign = 'center';
      g.fillText(fmt.format((lg.lo + lg.hi) / 2), x + 115, y + 41);
    }
    const cap = this.caption();
    if (cap) {
      g.textAlign = 'right';
      const tw = g.measureText(cap).width;
      g.globalAlpha = 0.9;
      g.fillStyle = bg;
      g.fillRect(W - tw - 24, H - 30, tw + 16, 22);
      g.globalAlpha = 1;
      g.fillStyle = ink;
      g.fillText(cap, W - 16, H - 19);
    }
    return c;
  }

  /** The next frame drawn, as a PNG (downloaded); resolves with its file name. */
  screenshot(): Promise<string> {
    return new Promise((resolve, reject) => {
      this.pending.push((c) => {
        c.toBlob((b) => {
          if (!b) return reject(new Error('The picture could not be made.'));
          const name = captureName('png');
          download(b, name);
          resolve(name);
        }, 'image/png');
      });
      // A paused flow still draws every frame, so the next one comes within a frame.
    });
  }

  /** Start recording the view (each frame the engine draws), or say why it cannot. */
  startRecording(): string | null {
    if (this.recording) return null;
    if (!this.canRecord) return 'This browser cannot record the view (no MediaRecorder with WebM).';
    this.compose();
    const stream = this.canvas.captureStream(30);
    const type = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 12_000_000 });
    this.chunks = [];
    rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    rec.onstop = () => {
      for (const t of stream.getTracks()) t.stop();
      if (this.chunks.length) download(new Blob(this.chunks, { type: 'video/webm' }), captureName('webm'));
      this.chunks = [];
    };
    rec.start(1000);
    this.recorder = rec;
    this.recording = { since: performance.now() };
    this.emit();
    return null;
  }

  stopRecording() {
    if (!this.recorder) return;
    this.recorder.stop();
    this.recorder = null;
    this.recording = null;
    this.emit();
  }
}
