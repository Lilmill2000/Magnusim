/**
 * The dock's picture viewer (phase 4 spec 2.6, 10.2): one of a turn's pictures, fit to the
 * panel. Escape or × closes it (and the Escape goes no further: the dock stays open), ← and →
 * go through the turn's pictures. It traps nothing; closing gives the keyboard back to the
 * thumbnail that opened it.
 */
import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import type { ImageRef } from '../wire';
import { CLOSE_PICTURE, NEXT_PICTURE, PICTURE_GONE, PICTURE_VIEWER, PREVIOUS_PICTURE } from './copy';
import { imageUrl } from './ToolStep';

export interface ViewerPicture {
  turn: string;
  image: ImageRef;
  alt: string;
}

export function Viewer({ pictures, index, onIndex, onClose }: { pictures: readonly ViewerPicture[]; index: number; onIndex: (i: number) => void; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLElement | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const pic = pictures[Math.max(0, Math.min(index, pictures.length - 1))];
  useLayoutEffect(() => {
    opener.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus({ preventScroll: true });
    return () => {
      const back = opener.current;
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
  }, []);
  useEffect(() => setGone(null), [pic?.turn, pic?.image.n]);
  if (!pic) return null;
  const key = `${pic.turn}/${pic.image.n}`;
  const go = (d: number) => {
    if (pictures.length < 2) return;
    onIndex((index + d + pictures.length) % pictures.length);
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      go(-1);
    } else if (e.key === 'ArrowRight') {
      e.preventDefault();
      go(1);
    }
  };
  return (
    <div className="dock-viewer" role="dialog" aria-label={PICTURE_VIEWER} data-dock-viewer="1" onKeyDown={onKeyDown}>
      <div className="dock-viewer-bar">
        <span className="dock-muted">{pic.alt}</span>
        <span className="assistant-dock-head-gap" />
        {pictures.length > 1 ? (
          <>
            <button type="button" className="assistant-dock-icon" aria-label={PREVIOUS_PICTURE} title={PREVIOUS_PICTURE} onClick={() => go(-1)}>
              ←
            </button>
            <button type="button" className="assistant-dock-icon" aria-label={NEXT_PICTURE} title={NEXT_PICTURE} onClick={() => go(1)}>
              →
            </button>
          </>
        ) : null}
        <button type="button" ref={closeRef} className="assistant-dock-icon" aria-label={CLOSE_PICTURE} title={CLOSE_PICTURE} data-dock-viewer-close="1" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="dock-viewer-body">
        {gone === key ? <p className="dock-muted">{PICTURE_GONE}</p> : <img src={imageUrl(pic.turn, pic.image.n)} alt={pic.alt} onError={() => setGone(key)} />}
      </div>
    </div>
  );
}
