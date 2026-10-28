/**
 * A picture of a window that has no 3D view (Home), for core__view (core host tools spec 5.2):
 * drawn on a canvas from what the browser laid out, as the person sees it: each box's background
 * and border, the pictures in it (the project previews), form values, and every word of text
 * where it shows, clipped as the page clips it, in document order (a panel over the cards covers
 * them). A browser gives a page no way to take a
 * screenshot of itself, and the app takes no library for it: this is a drawing of the same
 * layout, not a screenshot (SVG icons and shadows are left out). Only pictures from the app
 * itself are drawn (another site's would make the canvas unreadable); others show as their box.
 */

export interface PagePicture {
  blob: Blob;
  width: number;
  height: number;
  type: string;
}

/** The most a side or a picture may be (the app's IMAGE_CAPS: 2000 px, 1.5 MB). */
export const PAGE_PICTURE_SIDE = 2000;
export const PAGE_PICTURE_BYTES = 1.5 * 1024 * 1024;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A colour with some opacity ('' and transparent are none). */
function painted(color: string): boolean {
  if (!color || color === 'transparent') return false;
  const m = /rgba?\(([^)]+)\)/.exec(color);
  if (!m) return true;
  const parts = m[1].split(/[\s,/]+/).filter(Boolean);
  return parts.length < 4 || Number(parts[3]) > 0;
}

function visible(el: Element, cs: CSSStyleDeclaration): boolean {
  const check = (el as Element & { checkVisibility?: (o: Record<string, boolean>) => boolean }).checkVisibility;
  if (typeof check === 'function' && !check.call(el, { checkOpacity: true, checkVisibilityCSS: true })) return false;
  return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || '1') > 0;
}

function intersect(a: Box, b: Box): Box | null {
  const x = Math.max(a.x, b.x);
  const y = Math.max(a.y, b.y);
  const r = Math.min(a.x + a.w, b.x + b.w);
  const bt = Math.min(a.y + a.h, b.y + b.h);
  return r > x && bt > y ? { x, y, w: r - x, h: bt - y } : null;
}

const boxOf = (r: DOMRect): Box => ({ x: r.left, y: r.top, w: r.width, h: r.height });

/** Whether an image comes from this app (drawing another site's would make the canvas unreadable). */
function sameOrigin(src: string): boolean {
  if (!src) return false;
  if (src.startsWith('data:') || src.startsWith('blob:')) return true;
  try {
    return new URL(src, location.href).origin === location.origin;
  } catch {
    return false;
  }
}

/**
 * Draws `root` as laid out, the part of it in the window (`aspect` '16:9', '4:3' or '1:1' crops
 * the middle of it; 'view' keeps the window's shape), `width` pixels wide at most. Null when the
 * window shows nothing or the canvas can't be read.
 */
export async function drawPagePicture(root: HTMLElement, o: { aspect: string; width: number }): Promise<PagePicture | null> {
  const view: Box = { x: 0, y: 0, w: window.innerWidth, h: window.innerHeight };
  const shown = intersect(boxOf(root.getBoundingClientRect()), view);
  if (!shown) return null;
  let frame = shown;
  const m = /^(\d+):(\d+)$/.exec(String(o.aspect || 'view'));
  if (m && Number(m[1]) > 0 && Number(m[2]) > 0) {
    const ar = Number(m[1]) / Number(m[2]);
    if (frame.w / frame.h > ar) frame = { ...frame, x: frame.x + (frame.w - frame.h * ar) / 2, w: frame.h * ar };
    else frame = { ...frame, y: frame.y + (frame.h - frame.w / ar) / 2, h: frame.w / ar };
  }
  let width = Math.max(64, Math.min(PAGE_PICTURE_SIDE, Math.round(Number(o.width) || 1024)));
  for (let tries = 0; tries < 5; tries += 1) {
    let scale = width / frame.w;
    if (frame.h * scale > PAGE_PICTURE_SIDE) scale = PAGE_PICTURE_SIDE / frame.h;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(frame.w * scale));
    canvas.height = Math.max(1, Math.round(frame.h * scale));
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    ctx.scale(scale, scale);
    ctx.translate(-frame.x, -frame.y);
    lightPage(() => paint(ctx, root, frame));
    let blob: Blob | null = null;
    try {
      blob = await toBlob(canvas, 'image/png');
      if (blob && blob.size > PAGE_PICTURE_BYTES) blob = await toBlob(canvas, 'image/jpeg', 0.85);
    } catch {
      return null;
    }
    if (blob && blob.size <= PAGE_PICTURE_BYTES) return { blob, width: canvas.width, height: canvas.height, type: blob.type || 'image/png' };
    width = Math.round(width * 0.7);
  }
  return null;
}

/**
 * Runs `fn` with the page in the light theme: a picture the app keeps is light whatever the theme
 * (Daniel, 2026-10-27), as a capture of the 3D view is. The theme goes back in the same task, so the
 * screen never shows it (and the theme's watchers see no change).
 */
function lightPage<T>(fn: () => T): T {
  const html = document.documentElement;
  const was = html.getAttribute('data-theme');
  if (was !== 'dark') return fn();
  html.setAttribute('data-theme', 'light');
  try {
    return fn();
  } finally {
    html.setAttribute('data-theme', was);
  }
}

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => resolve(b), type, quality);
    } catch (err) {
      reject(err);
    }
  });
}

/** The page's own background, then each box in document order, then its text on top. */
function paint(ctx: CanvasRenderingContext2D, root: HTMLElement, frame: Box): void {
  const page = getComputedStyle(document.body);
  const html = getComputedStyle(document.documentElement);
  ctx.fillStyle = painted(page.backgroundColor) ? page.backgroundColor : painted(html.backgroundColor) ? html.backgroundColor : '#ffffff';
  ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
  const styles = new Map<Element, CSSStyleDeclaration>();
  const styleOf = (el: Element): CSSStyleDeclaration => {
    let cs = styles.get(el);
    if (!cs) {
      cs = getComputedStyle(el);
      styles.set(el, cs);
    }
    return cs;
  };
  const clips = new Map<Element, Box | null>();
  /** Where an element's content shows: the window, cut by every ancestor that clips its overflow. */
  const clipOf = (el: Element | null): Box | null => {
    if (!el || el === document.documentElement) return frame;
    if (clips.has(el)) return clips.get(el) ?? null;
    const up = clipOf(el.parentElement);
    const cs = styleOf(el);
    const clipped = cs.overflowX !== 'visible' || cs.overflowY !== 'visible';
    const out = up && clipped ? intersect(up, boxOf(el.getBoundingClientRect())) : up;
    clips.set(el, out);
    return out;
  };
  const hidden = new Set<Element>();
  const range = document.createRange();
  /** An element's own text, as words where the browser put them (over its box, under later boxes). */
  const drawText = (el: Element, cs: CSSStyleDeclaration) => {
    const clip = clipOf(el);
    if (!clip || el.closest('script, style, noscript, template, svg')) return;
    let set = false;
    for (const n of Array.from(el.childNodes)) {
      if (n.nodeType !== Node.TEXT_NODE) continue;
      const text = n.textContent || '';
      if (!/\S/.test(text)) continue;
      if (!set) {
        set = true;
        ctx.save();
        ctx.beginPath();
        ctx.rect(clip.x, clip.y, clip.w, clip.h);
        ctx.clip();
        ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
        ctx.fillStyle = cs.color;
        ctx.textBaseline = 'middle';
      }
      for (const w of text.matchAll(/\S+/g)) {
        range.setStart(n, w.index ?? 0);
        range.setEnd(n, (w.index ?? 0) + w[0].length);
        const r = range.getClientRects()[0];
        if (!r || !r.width || !intersect(boxOf(r), clip)) continue;
        ctx.fillText(cs.textTransform === 'uppercase' ? w[0].toUpperCase() : w[0], r.left, r.top + r.height / 2);
      }
    }
    if (set) ctx.restore();
  };
  const all = [root, ...Array.from(root.querySelectorAll('*'))];
  for (const el of all) {
    if (el.parentElement && hidden.has(el.parentElement)) {
      hidden.add(el);
      continue;
    }
    const cs = styleOf(el);
    if (!visible(el, cs)) {
      hidden.add(el);
      continue;
    }
    if (el instanceof SVGElement && !(el instanceof SVGSVGElement)) continue;
    const box = boxOf(el.getBoundingClientRect());
    const clip = clipOf(el.parentElement);
    if (clip && box.w && box.h && intersect(box, clip)) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(clip.x, clip.y, clip.w, clip.h);
      ctx.clip();
      drawBox(ctx, el, cs, box);
      ctx.restore();
    }
    // In document order, so a later box (a panel over the cards) covers the text under it.
    drawText(el, cs);
  }
}

function drawBox(ctx: CanvasRenderingContext2D, el: Element, cs: CSSStyleDeclaration, b: Box): void {
  const radius = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, b.w / 2, b.h / 2);
  const shape = () => {
    ctx.beginPath();
    if (radius > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(b.x, b.y, b.w, b.h, radius);
    else ctx.rect(b.x, b.y, b.w, b.h);
  };
  if (painted(cs.backgroundColor)) {
    ctx.fillStyle = cs.backgroundColor;
    shape();
    ctx.fill();
  }
  if (el instanceof HTMLImageElement && el.complete && el.naturalWidth > 0 && sameOrigin(el.currentSrc || el.src)) {
    drawImage(ctx, el, el.naturalWidth, el.naturalHeight, cs.objectFit, b);
  } else if (el instanceof HTMLCanvasElement && el.width > 0 && el.height > 0) {
    try {
      ctx.drawImage(el, b.x, b.y, b.w, b.h);
    } catch {
      /* a canvas that can't be read is left as its box */
    }
  } else if ((el instanceof HTMLInputElement && !['hidden', 'checkbox', 'radio', 'range', 'file', 'color'].includes(el.type)) || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const value = el instanceof HTMLSelectElement ? (el.selectedOptions[0]?.textContent ?? '') : el.value || el.placeholder || '';
    if (value && el.type !== 'password') {
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.clip();
      ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
      ctx.fillStyle = cs.color;
      ctx.textBaseline = 'middle';
      ctx.fillText(value, b.x + (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.borderLeftWidth) || 0), b.y + b.h / 2);
      ctx.restore();
    }
  }
  const sides: Array<[string, string, (wd: number) => [number, number, number, number]]> = [
    ['Top', 'top', (wd) => [b.x, b.y, b.w, wd]],
    ['Right', 'right', (wd) => [b.x + b.w - wd, b.y, wd, b.h]],
    ['Bottom', 'bottom', (wd) => [b.x, b.y + b.h - wd, b.w, wd]],
    ['Left', 'left', (wd) => [b.x, b.y, wd, b.h]],
  ];
  const widths = sides.map(([s]) => parseFloat(cs.getPropertyValue(`border-${s.toLowerCase()}-width`)) || 0);
  const colors = sides.map(([s]) => cs.getPropertyValue(`border-${s.toLowerCase()}-color`));
  const styles = sides.map(([s]) => cs.getPropertyValue(`border-${s.toLowerCase()}-style`));
  const same = widths.every((w) => w === widths[0]) && colors.every((c) => c === colors[0]) && styles.every((s) => s === styles[0]);
  if (same && widths[0] > 0 && painted(colors[0]) && styles[0] !== 'none' && styles[0] !== 'hidden') {
    ctx.strokeStyle = colors[0];
    ctx.lineWidth = widths[0];
    ctx.beginPath();
    const half = widths[0] / 2;
    if (radius > 0 && typeof ctx.roundRect === 'function') ctx.roundRect(b.x + half, b.y + half, b.w - widths[0], b.h - widths[0], Math.max(0, radius - half));
    else ctx.rect(b.x + half, b.y + half, b.w - widths[0], b.h - widths[0]);
    ctx.stroke();
    return;
  }
  sides.forEach(([, , rect], i) => {
    if (!(widths[i] > 0) || !painted(colors[i]) || styles[i] === 'none' || styles[i] === 'hidden') return;
    ctx.fillStyle = colors[i];
    ctx.fillRect(...rect(widths[i]));
  });
}

/** An image in its box as object-fit lays it out (cover and contain; anything else fills it). */
function drawImage(ctx: CanvasRenderingContext2D, img: CanvasImageSource, iw: number, ih: number, fit: string, b: Box): void {
  try {
    if (fit === 'cover' || fit === 'contain') {
      const s = fit === 'cover' ? Math.max(b.w / iw, b.h / ih) : Math.min(b.w / iw, b.h / ih);
      const w = iw * s;
      const h = ih * s;
      ctx.save();
      ctx.beginPath();
      ctx.rect(b.x, b.y, b.w, b.h);
      ctx.clip();
      ctx.drawImage(img, b.x + (b.w - w) / 2, b.y + (b.h - h) / 2, w, h);
      ctx.restore();
    } else {
      ctx.drawImage(img, b.x, b.y, b.w, b.h);
    }
  } catch {
    /* an image that can't be drawn is left as its box */
  }
}
