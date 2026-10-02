/**
 * The UI kit dev sheet, #/dev/ui-kit (only on a dev server started with
 * VITE_MAGNUSIM_DEV_SHEETS=1; see main.tsx). Four columns: the tokens, the
 * core today beside its kit twins, the kit in this page, and the kit in a
 * sandboxed workspace frame (/plugin-sdk/ui-kit-sheet.html). No shell, no
 * runtime and no project; style.css, the tokens and kit.css are loaded.
 */
import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import * as kit from '../../plugin-ui';
import tokensCss from '../../theme/tokens.css?raw';
import { Sheet } from './Sheet';
import { FoundationCore } from './sections/Foundation.core';
import { ControlsCore } from './sections/Controls.core';
import { PanelsCore } from './sections/Panels.core';
import { DataCore } from './sections/Data.core';

const CORE = [FoundationCore, ControlsCore, PanelsCore, DataCore];

const SCROLL: CSSProperties = {
  position: 'fixed',
  inset: 0,
  overflow: 'auto',
  background: 'var(--mg-surface-muted)',
  fontFamily: 'var(--mg-font)',
  color: 'var(--mg-text)',
};
const ROW: CSSProperties = { display: 'flex', alignItems: 'flex-start', gap: 16, padding: 16, width: 'max-content' };
// 336 px wide with 8 px padding, so a 320 px specimen box fits as it does in the frame.
const COLUMN: CSSProperties = { flex: 'none', boxSizing: 'border-box', width: 336, minWidth: 336, padding: 8, background: 'var(--mg-bg)' };
const COLUMN_TITLE: CSSProperties = { display: 'block', margin: '0 0 8px', fontSize: 15, fontWeight: 600, color: 'var(--mg-text)' };

function Column({ title, children, plain }: { title: string; children: ReactNode; plain?: boolean }) {
  return (
    <div style={plain ? { flex: 'none', width: 336, minWidth: 336 } : COLUMN}>
      <div style={COLUMN_TITLE}>{title}</div>
      {children}
    </div>
  );
}

/** Every --mg-* token as tokens.css declares it, with a swatch for colours. */
function Tokens() {
  const rows = [...tokensCss.matchAll(/^\s*(--mg-[\w-]+)\s*:\s*([^;]+);/gm)].map((m) => [m[1], m[2].trim()]);
  return (
    <div>
      {rows.map(([name, value]) => (
        <div key={name} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '2px 0', fontSize: 11 }}>
          <span
            style={{
              flex: 'none',
              width: 16,
              height: 16,
              border: '1px solid var(--mg-border)',
              background: /^(#|rgba?\()/.test(value) ? `var(${name})` : 'transparent',
            }}
          />
          <span style={{ fontFamily: 'var(--mg-font-mono)' }}>{name}</span>
          <span style={{ color: 'var(--mg-text-muted)' }}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function Page() {
  const rootRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [frameHeight, setFrameHeight] = useState(800);

  useEffect(() => {
    // The frame posts its content height; only messages from that frame count.
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const data = e.data as { type?: unknown; height?: unknown } | null;
      if (data && data.type === 'kit-sheet-height' && typeof data.height === 'number' && data.height > 0) {
        setFrameHeight(Math.ceil(data.height));
      }
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  useEffect(() => {
    let live = true;
    void document.fonts.ready.then(() => {
      if (live) rootRef.current?.setAttribute('data-kit-sheet-ready', 'page');
    });
    return () => {
      live = false;
    };
  }, []);

  return (
    <div ref={rootRef} style={SCROLL}>
      <div style={ROW}>
        <Column title="Tokens">
          <Tokens />
        </Column>
        <Column title="Core today (core box, then its kit twin)">
          {CORE.map((Core, i) => (
            <Core key={i} />
          ))}
        </Column>
        <Column title="Kit in page">
          <Sheet kit={kit} side="page" />
        </Column>
        <Column title="Kit in frame" plain>
          <iframe
            ref={frameRef}
            sandbox="allow-scripts allow-downloads"
            src="/plugin-sdk/ui-kit-sheet.html"
            title="UI kit in a workspace frame"
            style={{ display: 'block', width: 336, minWidth: 336, height: frameHeight, border: 0, background: 'var(--mg-bg)' }}
          />
        </Column>
      </div>
    </div>
  );
}

/** Draw the sheet into the app's React root. Leaving #/dev/ reloads into the app. */
export function mount(el: HTMLElement): void {
  window.addEventListener('hashchange', () => {
    if (!location.hash.startsWith('#/dev/')) location.reload();
  });
  createRoot(el).render(<Page />);
}
