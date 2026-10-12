// The tunnel view: the WebGPU canvas the engine draws on, and an overlay for the
// selection, the turn handle and the pose a body is being dragged to.
// Drag a body to move it, its round handle to turn it (Shift: whole degrees), empty
// space or the middle button to pan, the wheel to zoom; double-click empty space fits.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'react';
import { contains, transform, type Poly } from '../geometry/polygon';
import { outline } from '../geometry/shapes';
import type { Engine } from '../sim/engine';
import type { Body, Scene } from '../scene/scene';
import type { Store } from '../app/store';

const HANDLE_GAP_PX = 26;
const HANDLE_R_PX = 7;

const outlines = new Map<string, Poly>();
function localOutline(b: Body): Poly {
  const key = JSON.stringify(b.shape);
  let p = outlines.get(key);
  if (!p) {
    p = outline(b.shape);
    if (outlines.size > 64) outlines.clear();
    outlines.set(key, p);
  }
  return p;
}

export function worldOutline(b: Body, pose: { x: number; y: number; angle: number }): Poly {
  return transform(localOutline(b), { x: pose.x, y: pose.y, theta: (-pose.angle * Math.PI) / 180 });
}

type Drag =
  | { kind: 'move'; id: string; startX: number; startY: number; bodyX: number; bodyY: number; angle: number; moved: boolean }
  | { kind: 'turn'; id: string; startAngle: number; pointerStart: number; angle: number; x: number; y: number }
  | { kind: 'pan'; startX: number; startY: number; cx: number; cy: number };

/** The turn handle of a body (CSS px from the view's top-left): above its outline, on the pivot's vertical. */
export function turnHandle(engine: Engine, b: Body): { x: number; y: number; cx: number; cy: number } {
  const v = engine.worldView;
  const toScreen = (x: number, y: number) => ({ x: v.w / 2 + (x - v.cx) / v.mpp, y: v.h / 2 - (y - v.cy) / v.mpp });
  const pose = engine.livePose(b.id) ?? { x: b.x, y: b.y, angle: b.angle };
  const poly = worldOutline(b, pose);
  let top = Infinity;
  for (let i = 1; i < poly.length; i += 2) top = Math.min(top, toScreen(0, poly[i]).y);
  const c = toScreen(pose.x, pose.y);
  return { x: c.x, y: top - HANDLE_GAP_PX, cx: c.x, cy: c.y };
}

export function fitView(engine: Engine, scene: Scene) {
  const v = engine.worldView;
  const { length, height } = scene.tunnel;
  const mpp = Math.max(length / Math.max(50, v.w - 32), height / Math.max(50, v.h - 32));
  engine.worldView = { ...v, cx: length / 2, cy: height / 2, mpp };
}

export function Viewport({ engine, store, onStatus }: { engine: Engine; store: Store; onStatus?: (text: string) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const overlay = useRef<HTMLCanvasElement>(null);
  const drag = useRef<Drag | null>(null);
  const fitted = useRef('');

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

  // Overlay drawing, every frame.
  useEffect(() => {
    let raf = 0;
    const css = getComputedStyle(document.documentElement);
    const sel = css.getPropertyValue('--t2d-select').trim() || 'black';
    const ghost = css.getPropertyValue('--t2d-ghost').trim() || 'gray';
    const handleFill = css.getPropertyValue('--mg-bg').trim() || 'white';
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const o = overlay.current;
      if (!o) return;
      const g = o.getContext('2d')!;
      const v = engine.worldView;
      g.setTransform(v.dpr, 0, 0, v.dpr, 0, 0);
      g.clearRect(0, 0, v.w, v.h);
      const { scene, selected } = store.get();
      const d = drag.current;
      for (const b of scene.bodies) {
        const isSel = b.id === selected;
        const target = d && 'id' in d && d.id === b.id ? { x: d.kind === 'move' ? d.bodyX : d.x, y: d.kind === 'move' ? d.bodyY : d.y, angle: d.angle } : null;
        const pose = poseOf(b);
        const path = (poly: Poly) => {
          g.beginPath();
          for (let i = 0; i < poly.length; i += 2) {
            const s = toScreen(poly[i], poly[i + 1]);
            if (i === 0) g.moveTo(s.x, s.y);
            else g.lineTo(s.x, s.y);
          }
          g.closePath();
        };
        if (!b.enabled) {
          path(worldOutline(b, pose));
          g.setLineDash([4, 4]);
          g.strokeStyle = ghost;
          g.lineWidth = 1.5;
          g.stroke();
          g.setLineDash([]);
        }
        if (target && (Math.abs(target.x - pose.x) > 1e-6 || Math.abs(target.y - pose.y) > 1e-6 || Math.abs(target.angle - pose.angle) > 1e-3)) {
          // Where the body is going; the flow's body catches up at the lattice's speed limit.
          path(worldOutline(b, target));
          g.setLineDash([5, 4]);
          g.strokeStyle = ghost;
          g.lineWidth = 1.5;
          g.stroke();
          g.setLineDash([]);
        }
        if (isSel) {
          path(worldOutline(b, pose));
          g.strokeStyle = sel;
          g.lineWidth = 2;
          g.stroke();
          if (!b.locked) {
            const h = handleOf(b);
            g.beginPath();
            g.moveTo(h.cx, h.cy);
            g.lineTo(h.x, h.y + HANDLE_R_PX);
            g.strokeStyle = sel;
            g.lineWidth = 1;
            g.stroke();
            g.beginPath();
            g.arc(h.x, h.y, HANDLE_R_PX, 0, Math.PI * 2);
            g.fillStyle = handleFill;
            g.fill();
            g.lineWidth = 2;
            g.stroke();
          }
          const c = toScreen(pose.x, pose.y);
          g.beginPath();
          g.moveTo(c.x - 5, c.y);
          g.lineTo(c.x + 5, c.y);
          g.moveTo(c.x, c.y - 5);
          g.lineTo(c.x, c.y + 5);
          g.lineWidth = 1.5;
          g.stroke();
        }
      }
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [engine, store]);

  const hitBody = (wx: number, wy: number): Body | null => {
    const bodies = store.get().scene.bodies;
    for (let i = bodies.length - 1; i >= 0; i--) {
      const b = bodies[i];
      if (contains(worldOutline(b, poseOf(b)), wx, wy)) return b;
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
    if (!d) {
      const w = toWorld(e.clientX, e.clientY);
      const hit = hitBody(w.x, w.y);
      wrap.current!.style.cursor = hit && !hit.locked ? 'grab' : 'default';
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
    onStatus?.('');
    if (!d || d.kind === 'pan') return;
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
    >
      <canvas ref={canvas} />
      <canvas ref={overlay} className="t2d-overlay" />
    </div>
  );
}
