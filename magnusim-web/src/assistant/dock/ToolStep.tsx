/**
 * One tool call in a turn's transcript (phase 4 spec 2.6): its title, where it ran, its risk,
 * what it sent (collapsed), its progress while it runs (a call that waits for the person in its
 * workspace in amber), and its result: "✓ <summary> · 0.8 s", or "✗ <summary>" with how to fix
 * it and the code. What it changed in the project ("Updated: Boundary conditions (Inlet)", from
 * the turn's ui_sync events; phase 5, C2). Its pictures (one per CAD edit) as thumbnails; a click
 * opens the dock's picture viewer. A finished export's Download link (the person saves the file).
 * A turn of many steps keeps only its newest three open (`open`); the person
 * may open or close any.
 *
 * Every string here is server data shown as text.
 */
import { useState } from 'react';
import type { ImageRef } from '../wire';
import { DOWNLOAD_TITLE, howToFix, PICTURE_GONE, pictureAlt, resultFailed, resultOk, riskBadge, updatedLine, waitsFor, WHAT_IT_SENT } from './copy';
import type { TurnItem } from './turnView';

type ToolItem = Extract<TurnItem, { kind: 'tool' }>;

/** Where a picture the turn keeps is read (same origin; nothing secret in it). */
export function imageUrl(turn: string, n: string): string {
  return `/api/assistant/turns/${encodeURIComponent(turn)}/images/${encodeURIComponent(n)}`;
}

/** A picture of the turn, or the words for one no longer kept. */
export function Thumb({ turn, image, alt, onOpen, className }: { turn: string; image: ImageRef; alt: string; onOpen?: () => void; className?: string }) {
  const [gone, setGone] = useState(false);
  if (gone) {
    return (
      <span className={`dock-thumb-gone ${className ?? ''}`} data-dock-picture-gone="1">
        {PICTURE_GONE}
      </span>
    );
  }
  const img = <img src={imageUrl(turn, image.n)} alt={alt} loading="lazy" decoding="async" onError={() => setGone(true)} />;
  if (!onOpen) return <span className={`dock-thumb ${className ?? ''}`}>{img}</span>;
  return (
    <button type="button" className={`dock-thumb ${className ?? ''}`} data-dock-picture={image.n} onClick={onOpen}>
      {img}
    </button>
  );
}

export function ToolStep({
  turn,
  item,
  open,
  workspace,
  onOpenPicture,
}: {
  turn: string;
  item: ToolItem;
  /** Shown open unless the person closed it (the newest three of a turn). */
  open: boolean;
  workspace: string;
  onOpenPicture?: (n: string) => void;
}) {
  const [touched, setTouched] = useState<boolean | null>(null);
  const isOpen = touched ?? open;
  const r = item.result;
  const p = item.progress;
  const images = r ? r.images : [];
  const title = item.title || item.tool;
  const updated = item.updated ? updatedLine(item.updated.kinds, item.updated.ids, item.updated.names) : '';
  const riskClass = item.risk === 'destructive' ? 'danger' : item.risk === 'compute' ? 'warning' : '';
  return (
    <details
      className="dock-step"
      data-dock-step={item.call}
      data-dock-step-state={r ? (r.ok ? 'ok' : 'failed') : 'running'}
      open={isOpen}
      onToggle={(e) => {
        const now = (e.currentTarget as HTMLDetailsElement).open;
        if (now !== isOpen) setTouched(now);
      }}
    >
      <summary className="dock-step-head">
        <span className="dock-step-title">{title}</span>
        {item.source ? <span className="dock-step-source">{item.source}</span> : null}
        <span className={`dock-badge ${riskClass}`} data-dock-risk={item.risk}>
          {riskBadge(item.risk)}
        </span>
        {r ? (
          <span className={`dock-step-result ${r.ok ? 'ok' : 'failed'}`} data-dock-result="1">
            {r.ok ? resultOk(r.summary, r.ms) : resultFailed(r.summary)}
          </span>
        ) : null}
      </summary>
      {!r && p ? (
        <div className={`dock-progress${p.waiting ? ' waiting' : ''}`} data-dock-progress={p.waiting ? 'waiting' : '1'}>
          <span
            className={`dock-progress-bar${p.fraction === null ? ' indeterminate' : ''}`}
            role="progressbar"
            aria-label={title}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={p.fraction === null ? undefined : Math.round(Math.max(0, Math.min(1, p.fraction)) * 100)}
          >
            <span style={p.fraction === null ? undefined : { width: `${Math.max(0, Math.min(1, p.fraction)) * 100}%` }} />
          </span>
          {p.waiting ? <span className="dock-progress-label">{waitsFor(workspace, p.label)}</span> : p.label ? <span className="dock-progress-label">{p.label}</span> : null}
        </div>
      ) : null}
      {updated ? (
        <p className="dock-muted dock-step-updated" data-dock-updated="1">
          {updated}
        </p>
      ) : null}
      {r && r.ok && r.links.length ? (
        <p className="dock-step-links">
          {r.links.map((l) => (
            // The person's click saves it (the browser's download); the Assistant never does.
            <a key={l.href} className="dock-download" href={l.href} download title={DOWNLOAD_TITLE} data-dock-download="1">
              {l.label}
            </a>
          ))}
        </p>
      ) : null}
      {r && !r.ok && r.hint ? <p className="dock-muted dock-step-hint">{howToFix(r.hint)}</p> : null}
      {r && !r.ok && r.code ? <p className="dock-muted dock-mono dock-step-code">{r.code}</p> : null}
      {item.input_preview ? (
        <details className="dock-sent">
          <summary>{WHAT_IT_SENT}</summary>
          <pre className="dock-mono">{item.input_preview}</pre>
        </details>
      ) : null}
      {images.length ? (
        <div className="dock-step-pictures">
          {images.map((im, i) => (
            <Thumb key={im.n} turn={turn} image={im} alt={pictureAlt(i + 1, images.length, title)} onOpen={onOpenPicture ? () => onOpenPicture(im.n) : undefined} />
          ))}
        </div>
      ) : null}
    </details>
  );
}
