// The tunnel view: the WebGPU canvas the engine draws on, and an overlay for the
// selection, the turn handle and the pose a body is being dragged to.
// Drag a body to move it, its round handle to turn it (Shift: whole degrees), empty
// space or the middle button to pan, the wheel to zoom; double-click empty space fits.
// While a sketch body is being edited, the left button belongs to the sketch editor (the
// middle button still pans and the wheel zooms). Probes are drawn and dragged here too, and
// hovering over the flow reads it under the pointer (the toolbar's hint).
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'react';
import type { UnitSystem } from '@magnusim/plugin-ui';
import { containsRings } from '../geometry/polygon';
import type { Engine } from '../sim/engine';
import type { Body, Rake, Scene } from '../scene/scene';
import type { Store } from '../app/store';
import { applyViewColours, overlayColours } from '../app/colours';
import { useAppearance } from '../app/hooks';
import type { SketchEditor } from '../sketch/editor';
import { readingText } from './forces';
import { HANDLE_R_PX, PROBE_R_PX, overlayState, paintOverlay, turnHandle, worldOutline, type Drag } from './overlay';

export function fitView(engine: Engine, scene: Scene) {
  const v = engine.worldView;
  const { length, height } = scene.tunnel;
  const mpp = Math.max(length / Math.max(50, v.w - 32), height / Math.max(50, v.h - 32));
  engine.worldView = { ...v, cx: length / 2, cy: height / 2, mpp };
}

export function Viewport({ engine, store, editor, units = 'metric', onStatus }: { engine: Engine; store: Store; editor?: SketchEditor; units?: UnitSystem; onStatus?: (text: string) => void }) {
  /** The hover readout: the newest pointer position (world) and whether a read is on. */
  const hover = useRef<{ at: { x: number; y: number } | null; busy: boolean; last: number }>({ at: null, busy: false, last: 0 });
  const wrap = useRef<HTMLDivElement>(null);
  /** The last left press (for click counts: a PointerEvent's detail is not one). */
  const lastPress = useRef({ t: 0, x: 0, y: 0, n: 0 });
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const fitted = useRef('');
  const appearance = useAppearance();

  // Size: both canvases follow the element (device pixels for the GPU one).
  useEffect(() => {
    const el = wrap.current!;
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const c = engine.canvas;
      c.width = Math.max(1, Math.round(r.width * dpr));
      c.height = Math.max(1, Math.round(r.height * dpr));
      const o = overlay.current!;
      o.width = c.width;
      o.height = c.height;
      engine.worldView = { ...engine.worldView, w: r.width, h: r.height, dpr };
      const scene = store.get().scene;
      const key = `${scene.tunnel.length}x${scene.tunnel.height}`;
      if (fitted.current !== key) {
        fitView(engine, scene);
        fitted.current = key;
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [engine, store]);

  // The GPU canvas belongs to the engine (made once); put it in this element.
  useEffect(() => {
    const host = canvas.current!;
    host.replaceWith(engine.canvas);
    engine.canvas.className = 't2d-canvas';
    engine.canvas.setAttribute('data-t2d-canvas', '1');
    return () => {
      engine.canvas.replaceWith(host);
    };
  }, [engine]);

  // Refit when the tunnel's size changes.
  useEffect(
    () =>
      store.subscribe(() => {
        const s = store.get().scene;
        const key = `${s.tunnel.length}x${s.tunnel.height}`;
        if (fitted.current && fitted.current !== key) {
          fitView(engine, s);
          fitted.current = key;
        }
      }),
    [engine, store],
  );

  const toWorld = (cx: number, cy: number) => {
    const r = wrap.current!.getBoundingClientRect();
    const v = engine.worldView;
    return { x: v.cx + (cx - r.left - v.w / 2) * v.mpp, y: v.cy - (cy - r.top - v.h / 2) * v.mpp };
  };
  const toScreen = (x: number, y: number) => {
    const v = engine.worldView;
    return { x: v.w / 2 + (x - v.cx) / v.mpp, y: v.h / 2 - (y - v.cy) / v.mpp };
  };

  const poseOf = (b: Body) => engine.livePose(b.id) ?? { x: b.x, y: b.y, angle: b.angle };

  const handleOf = (b: Body) => turnHandle(engine, b);

  // The engine's colours, read where the view is (its stage may keep a theme of its own).
  useEffect(() => applyViewColours(engine, wrap.current!), [engine, appearance]);

  // Overlay drawing, every frame. Its colours are read where the view is, and again when the theme changes.
  useEffect(() => {
    let raf = 0;
    const css = getComputedStyle(wrap.current!);
    const colours = overlayColours((name) => css.getPropertyValue(name).trim());
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const o = overlay.current;
      if (!o) return;
      paintOverlay(o.getContext('2d')!, overlayState(engine, store, drag.current, editor), colours);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, store, editor, appearance]);

  const hitBody = (wx: number, wy: number): Body | null => {
    const bodies = store.get().scene.bodies;
    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      if (containsRings(worldOutline(b, poseOf(b)), wx, wy)) return b;
    }
    return null;
  };

  /** The probe under a screen point (client px). */
  const hitProbe = (cx: number, cy: number) => {
    const r0 = wrap.current!.getBoundingClientRect();
    const probes = store.get().scene.probes;
    for (let i = probes.length - 1; i >= 0; i--) {
      const s = toScreen(probes[i].x, probes[i].y);
      if (Math.hypot(cx - r0.left - s.x, cy - r0.top - s.y) <= PROBE_R_PX + 4) return probes[i];
    }
    return null;
  };

  /** Read the flow under the pointer for the toolbar's hint (at most ten times a second). */
  const readHover = (w: { x: number; y: number } | null) => {
    const h = hover.current;
    h.at = w;
    if (!w) {
      onStatus?.('');
      return;
    }
    const now = performance.now();
    if (h.busy || now - h.last < 100) return;
    h.busy = true;
    h.last = now;
    void engine
      .readAt([w])
      .then((r) => {
        // Only if the pointer is still over the flow and no drag took the hint since.
        if (r && hover.current.at && !drag.current) onStatus?.(readingText(r[0], units));
      })
      .finally(() => {
        hover.current.busy = false;
      });
  };

  /** The rake (and which part of it) under a screen point: an end of the selected rake, or the line. */
  const hitRake = (cx: number, cy: number): { rake: Rake; part: 'all' | 'start' | 'end' } | null => {
    const r0 = wrap.current!.getBoundingClientRect();
    const px = cx - r0.left;
    const py = cy - r0.top;
    const { scene, selected } = store.get();
    for (let i = scene.rakes.length - 1; i >= 0; i--) {
      const r = scene.rakes[i];
      const a = toScreen(r.x0, r.y0);
      const b = toScreen(r.x1, r.y1);
      if (r.id === selected) {
        if (Math.hypot(px - a.x, py - a.y) <= 8) return { rake: r, part: 'start' };
        if (Math.hypot(px - b.x, py - b.y) <= 8) return { rake: r, part: 'end' };
      }
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const l2 = dx * dx + dy * dy;
      const t = l2 > 0 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
      if (Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)) <= 6) return { rake: r, part: 'all' };
    }
    return null;
  };

  const clampToTunnel = (x: number, y: number) => {
    const t = store.get().scene.tunnel;
    return { x: Math.min(t.length, Math.max(0, x)), y: Math.min(t.height, Math.max(0, y)) };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    const v = engine.worldView;
    if (e.button === 1) {
      drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, cx: v.cx, cy: v.cy };
      return;
    }
    if (e.button !== 0) return;
    if (editor?.editing) {
      // The press is the sketch's: no focus change (a dimension's value box opening now keeps
      // its focus), and keys go to the sketch, not to a panel control left focused.
      e.preventDefault();
      const active = document.activeElement as HTMLElement | null;
      if (active && active !== document.body) active.blur();
      const r = wrap.current!.getBoundingClientRect();
      const lp = lastPress.current;
      const now = performance.now();
      const n = now - lp.t < 400 && Math.hypot(e.clientX - lp.x, e.clientY - lp.y) < 6 ? lp.n + 1 : 1;
      lastPress.current = { t: now, x: e.clientX, y: e.clientY, n };
      editor.pointerDown(w.x, w.y, { x: e.clientX - r.left, y: e.clientY - r.top }, { shift: e.shiftKey, clicks: n }, toScreen);
      return;
    }
    const { scene, selected } = store.get();
    const selBody = scene.bodies.find((b) => b.id === selected);
    if (selBody && !selBody.locked) {
      const h = handleOf(selBody);
      const r = wrap.current!.getBoundingClientRect();
      if (Math.hypot(e.clientX - r.left - h.x, e.clientY - r.top - h.y) <= HANDLE_R_PX + 4) {
        const pose = poseOf(selBody);
        const a0 = Math.atan2(w.y - pose.y, w.x - pose.x);
        drag.current = { kind: 'turn', id: selBody.id, startAngle: selBody.angle, pointerStart: a0, angle: selBody.angle, x: selBody.x, y: selBody.y };
        return;
      }
    }
    const pr = hitProbe(e.clientX, e.clientY);
    if (pr) {
      store.select(pr.id);
      drag.current = { kind: 'probe', id: pr.id, before: store.get().scene, moved: false };
      return;
    }
    const rk = hitRake(e.clientX, e.clientY);
    if (rk) {
      store.select(rk.rake.id);
      drag.current = { kind: 'rake', id: rk.rake.id, part: rk.part, startX: w.x, startY: w.y, r0: rk.rake, before: store.get().scene };
      return;
    }
    const hit = hitBody(w.x, w.y);
    if (hit) {
      store.select(hit.id);
      if (!hit.locked) drag.current = { kind: 'move', id: hit.id, startX: w.x, startY: w.y, bodyX: hit.x, bodyY: hit.y, angle: hit.angle, moved: false };
      return;
    }
    store.select(null);
    drag.current = { kind: 'pan', startX: e.clientX, startY: e.clientY, cx: v.cx, cy: v.cy };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (editor?.editing && (!d || d.kind !== 'pan')) {
      const w = toWorld(e.clientX, e.clientY);
      editor.pointerMove(w.x, w.y);
      wrap.current!.style.cursor = 'crosshair';
      return;
    }
    if (!d) {
      const w = toWorld(e.clientX, e.clientY);
      const pr = hitProbe(e.clientX, e.clientY);
      const rk = pr ? null : hitRake(e.clientX, e.clientY);
      const hit = pr || rk ? null : hitBody(w.x, w.y);
      wrap.current!.style.cursor = pr ? 'move' : rk ? (rk.part === 'all' ? 'move' : 'crosshair') : hit && !hit.locked ? 'grab' : 'default';
      readHover(w);
      return;
    }
    if (d.kind === 'probe') {
      const w = toWorld(e.clientX, e.clientY);
      const p = clampToTunnel(w.x, w.y);
      d.moved = true;
      const s = store.get().scene;
      store.commit({ ...s, probes: s.probes.map((x) => (x.id === d.id ? { ...x, x: p.x, y: p.y } : x)) }, false);
      onStatus?.(`x ${p.x.toFixed(3)} m, y ${p.y.toFixed(3)} m`);
      return;
    }
    if (d.kind === 'rake') {
      const w = toWorld(e.clientX, e.clientY);
      const ddx = w.x - d.startX;
      const ddy = w.y - d.startY;
      const r = d.r0;
      const s0 = clampToTunnel(r.x0 + (d.part === 'end' ? 0 : ddx), r.y0 + (d.part === 'end' ? 0 : ddy));
      const s1 = clampToTunnel(r.x1 + (d.part === 'start' ? 0 : ddx), r.y1 + (d.part === 'start' ? 0 : ddy));
      const s = store.get().scene;
      store.commit({ ...s, rakes: s.rakes.map((x) => (x.id === d.id ? { ...x, x0: s0.x, y0: s0.y, x1: s1.x, y1: s1.y } : x)) }, false);
      return;
    }
    if (d.kind === 'pan') {
      const v = engine.worldView;
      engine.worldView = { ...v, cx: d.cx - (e.clientX - d.startX) * v.mpp, cy: d.cy + (e.clientY - d.startY) * v.mpp };
      return;
    }
    const w = toWorld(e.clientX, e.clientY);
    const body = store.get().scene.bodies.find((b) => b.id === d.id);
    if (!body) return;
    if (d.kind === 'move') {
      const p = clampToTunnel(body.x + (w.x - d.startX), body.y + (w.y - d.startY));
      d.bodyX = p.x;
      d.bodyY = p.y;
      d.moved = true;
      wrap.current!.style.cursor = 'grabbing';
      engine.setTarget(d.id, { x: p.x, y: p.y, angle: d.angle });
      onStatus?.(`x ${p.x.toFixed(3)} m, y ${p.y.toFixed(3)} m`);
    } else {
      const pose = poseOf(body);
      const a = Math.atan2(w.y - pose.y, w.x - pose.x);
      let angle = d.startAngle - ((a - d.pointerStart) * 180) / Math.PI;
      angle = ((((angle + 180) % 360) + 360) % 360) - 180;
      if (e.shiftKey) angle = Math.round(angle);
      d.angle = angle;
      engine.setTarget(d.id, { x: d.x, y: d.y, angle });
      onStatus?.(`Angle ${angle.toFixed(1)}°`);
    }
  };

  const onPointerUp = () => {
    const d = drag.current;
    drag.current = null;
    if (editor?.editing && !d) {
      editor.pointerUp();
      return;
    }
    onStatus?.('');
    if (!d || d.kind === 'pan') return;
    if (d.kind === 'probe') {
      const now = store.get().scene;
      if (d.moved && now !== d.before) store.commitFrom(d.before, now);
      return;
    }
    if (d.kind === 'rake') {
      const now = store.get().scene;
      if (now !== d.before) store.commitFrom(d.before, now);
      return;
    }
    if (d.kind === 'move' && d.moved) store.updateBody(d.id, { x: d.bodyX, y: d.bodyY });
    if (d.kind === 'turn') store.updateBody(d.id, { angle: d.angle });
    engine.setTarget(d.id, null);
  };

  const onWheel = (e: React.WheelEvent) => {
    const v = engine.worldView;
    const before = toWorld(e.clientX, e.clientY);
    const t = store.get().scene.tunnel;
    const mpp = Math.min(Math.max(t.length, t.height) / 50, Math.max(t.length / 1e5, v.mpp * Math.exp(e.deltaY * 0.0015)));
    engine.worldView = { ...v, mpp };
    const after = toWorld(e.clientX, e.clientY);
    engine.worldView = { ...engine.worldView, cx: engine.worldView.cx + (before.x - after.x), cy: engine.worldView.cy + (before.y - after.y) };
  };

  const onDoubleClick = (e: React.MouseEvent) => {
    if (editor?.editing) return;
    const w = toWorld(e.clientX, e.clientY);
    if (!hitBody(w.x, w.y)) fitView(engine, store.get().scene);
  };

  return (
    <div
      ref={wrap}
      className="t2d-viewport"
      data-t2d-viewport
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onWheel={onWheel}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => e.preventDefault()}
      onPointerLeave={() => !drag.current && readHover(null)}
    >
      <canvas ref={canvas} />
      <canvas ref={overlay} className="t2d-overlay" />
    </div>
  );
}
