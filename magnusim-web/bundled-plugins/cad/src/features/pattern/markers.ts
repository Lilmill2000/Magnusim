// The copies' markers in the view while a pattern's panel is open: a small numbered button on
// each copy (where the source's centre went), the original's marked "1", a skipped copy hollow
// and struck through. A click on a copy's marker leaves the copy out (or brings it back), as
// SolidWorks' "Instances to skip" and Fusion's "Suppress" checkboxes do. Buttons over the
// canvas (layer html), placed with the view's projection on every frame.
// Owner: P4b PATTERN.
// SPDX-License-Identifier: GPL-3.0-or-later
import { useEffect, useRef } from 'react';
import type { AppServices } from '../../types/app';
import type { Vec3 } from '../../types/doc';
import type { PatternOutput } from '../../types/doc-service';
import type { OverlayLayer, ViewportHandle } from '../../types/viewport';

export const MARKERS_LAYER = 'pattern.markers';

interface Marker {
  key: string;
  at: Vec3;
  el: HTMLElement;
}

class Markers {
  private readonly layer: OverlayLayer;
  private readonly off: () => void;
  private markers: Marker[] = [];

  constructor(
    private readonly handle: ViewportHandle,
    private readonly onToggle: (key: string) => void,
  ) {
    this.layer = handle.addLayer(MARKERS_LAYER, { order: 70 });
    this.layer.html.classList.add('cad-pattern-markers');
    this.off = handle.onFrame(() => this.place());
  }

  set(out: PatternOutput | null, name: string): void {
    for (const m of this.markers) m.el.remove();
    this.markers = [];
    if (!out) return;
    if (out.origin) {
      const el = document.createElement('span');
      el.className = 'cad-pattern-marker is-original';
      el.textContent = out.copies.some((c) => c.key === 'm') ? '•' : '1';
      el.setAttribute('data-pattern-marker', 'original');
      el.title = `The original of ${name}`;
      this.layer.html.appendChild(el);
      this.markers.push({ key: 'original', at: out.origin, el });
    }
    for (const c of out.copies) {
      const el = document.createElement('button');
      el.type = 'button';
      el.className = `cad-pattern-marker${c.skipped ? ' is-skipped' : ''}${c.failed ? ' is-failed' : ''}`;
      el.textContent = c.key === 'm' ? 'M' : c.label.replace(/^Instance /, '');
      el.setAttribute('data-pattern-marker', c.key);
      el.setAttribute('aria-pressed', c.skipped ? 'true' : 'false');
      el.setAttribute('aria-label', c.skipped ? `${c.label} is skipped: click to make it again` : `${c.label}: click to skip it`);
      el.title = el.getAttribute('aria-label')!;
      el.addEventListener('pointerdown', (e) => e.stopPropagation());
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        this.onToggle(c.key);
      });
      this.layer.html.appendChild(el);
      this.markers.push({ key: c.key, at: c.at, el });
    }
    this.place();
    this.layer.changed();
  }

  private place(): void {
    if (!this.markers.length) return;
    const r = this.layer.html.getBoundingClientRect();
    for (const m of this.markers) {
      const s = this.handle.project(m.at);
      if (!s) {
        m.el.hidden = true;
        continue;
      }
      m.el.hidden = false;
      m.el.style.left = `${s[0] - r.left}px`;
      m.el.style.top = `${s[1] - r.top}px`;
    }
  }

  dispose(): void {
    this.off();
    for (const m of this.markers) m.el.remove();
    this.markers = [];
    this.layer.dispose();
  }
}

/** Draw `out`'s markers while mounted (the panel is open); a click on one calls `onToggle(key)`. */
export function usePatternMarkers(services: AppServices, out: PatternOutput | null, name: string, onToggle: (key: string) => void): void {
  const markers = useRef<Markers | null>(null);
  const toggle = useRef(onToggle);
  toggle.current = onToggle;
  const latest = useRef({ out, name });
  latest.current = { out, name };
  useEffect(() => {
    let h = services.viewport.get().handle;
    const attach = () => {
      h = services.viewport.get().handle;
      markers.current?.dispose();
      markers.current = h && typeof h.addLayer === 'function' ? new Markers(h, (k) => toggle.current(k)) : null;
      markers.current?.set(latest.current.out, latest.current.name);
    };
    attach();
    const off = services.viewport.subscribe((s) => {
      if (s.handle !== h) attach();
    });
    return () => {
      off();
      markers.current?.dispose();
      markers.current = null;
    };
  }, [services]);
  const key = JSON.stringify(out) + name;
  useEffect(() => {
    markers.current?.set(out, name);
  }, [key]);
}
