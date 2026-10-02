/**
 * Page only (page.tsx): the core's panel chrome, status blocks and the
 * workspace toast beside their kit twins. The parity gate compares each named
 * part of a pair over a fixed property set and expects no difference.
 */
import { useLayoutEffect, type CSSProperties } from 'react';
import { PanelChrome as CorePanelChrome } from '../../../panels/PanelChrome';
import { PanelChrome, StatusBlock, Toast } from '../../../plugin-ui';
import { Group } from './Foundation';
import { CorePair } from './Foundation.core';

const noop = () => undefined;

/** The app's flyout (`TD`), clickable as it is in the app. */
const TD: CSSProperties = { pointerEvents: 'auto' };
/** Both toasts shrink to fit and sit right, as the absolute workspace toast did. */
const TOAST_COLUMN: CSSProperties = { display: 'flex', flexDirection: 'column', alignItems: 'flex-end' };

/**
 * The workspace toast's rules as they were before H14 (style.css at 83ebaf5),
 * renamed wsx-, without their place, and with the info accent's value then
 * (#1570ef; --mg-primary is #3b5bdb now). Page only, so the kit's class rules
 * do not apply to it.
 */
const WSX_TOAST_CSS = `
.wsx-toast {
  display: flex;
  align-items: center;
  gap: var(--mg-space-3);
  max-width: 420px;
  padding: 10px 12px;
  background: var(--mg-bg);
  border: 1px solid var(--mg-border-subtle);
  border-left: 3px solid #1570ef;
  border-radius: var(--mg-radius-md);
  box-shadow: var(--mg-shadow-sm);
  font-size: var(--mg-text-md);
}
.wsx-toast.is-success { border-left-color: var(--mg-success); }
.wsx-toast.is-error { border-left-color: var(--mg-danger); }
.wsx-toast-close { border: 0; background: none; font-size: 16px; line-height: 1; color: var(--mg-text-muted); cursor: pointer; }
`;

/**
 * Names a pair's parts (data-kit-part) inside markup this file does not write:
 * the core PanelChrome and the kit components. Renders nothing; it finds its
 * box by the pair's name.
 */
function Parts({ pair, side, parts }: { pair: string; side: 'core' | 'kit'; parts: Record<string, string> }) {
  useLayoutEffect(() => {
    const box = document.querySelector(`[data-kit-core-${side === 'core' ? 'pair' : 'kit'}="${pair}"]`);
    if (!box) return;
    for (const [name, selector] of Object.entries(parts)) box.querySelector(selector)?.setAttribute('data-kit-part', name);
  });
  return null;
}

const BODY = 'First layer 0.1 mm, growth 1.2, 5 layers.';

const CORE_CHROME_PARTS = {
  head: '.mat-panel-head',
  title: '.mat-panel-title',
  body: '.mat-panel-body',
  foot: '.mat-panel-foot',
  'foot-left': '.mesh-foot-left',
  delete: '.mat-clear-link',
  done: '.tree-panel-done',
};
const KIT_CHROME_PARTS = {
  head: '.mgk-panel-head',
  title: '.mgk-panel-title',
  body: '.mgk-panel-body',
  foot: '.mgk-panel-foot',
  'foot-left': '.mgk-panel-foot-left',
  delete: '.mgk-btn--link',
  done: '.mgk-panel-done',
};

function ToastPair({ kind, message }: { kind: 'info' | 'success' | 'error'; message: string }) {
  const pair = `Toast/${kind}`;
  return (
    <CorePair
      pair={pair}
      core={
        <div style={TOAST_COLUMN}>
          <div className={`wsx-toast is-${kind}`} role="status" data-kit-part="root">
            <span data-kit-part="msg">{message}</span>
            <button type="button" className="wsx-toast-close" aria-label="Close" data-kit-part="close">
              ×
            </button>
          </div>
        </div>
      }
      kit={
        <>
          <div style={TOAST_COLUMN}>
            <Toast message={message} kind={kind} durationMs={0} onClose={noop} attrs={{ 'data-kit-part': 'root' }} />
          </div>
          <Parts pair={pair} side="kit" parts={{ msg: '.mgk-toast-msg', close: '.mgk-toast-close' }} />
        </>
      }
    />
  );
}

export function PanelsCore() {
  return (
    <>
      <Group title="PanelChrome (core, then kit)">
        <CorePair
          pair="PanelChrome/flyout"
          core={
            <>
              <div className="tree-detail" style={TD}>
                <div className="mat-panel">
                  <CorePanelChrome title="Boundary layer" onDelete={noop}>
                    {BODY}
                  </CorePanelChrome>
                </div>
              </div>
              <Parts pair="PanelChrome/flyout" side="core" parts={CORE_CHROME_PARTS} />
            </>
          }
          kit={
            <>
              <div className="tree-detail" style={TD}>
                <div className="mat-panel">
                  <PanelChrome title="Boundary layer" onDelete={noop} onDone={noop}>
                    {BODY}
                  </PanelChrome>
                </div>
              </div>
              <Parts pair="PanelChrome/flyout" side="kit" parts={KIT_CHROME_PARTS} />
            </>
          }
        />
        <CorePair
          pair="PanelChrome/card"
          core={
            <div className="tree-detail" style={TD}>
              <div className="mat-panel" data-kit-part="root">
                <CorePanelChrome title="Boundary layer" onDelete={noop}>
                  {BODY}
                </CorePanelChrome>
              </div>
            </div>
          }
          kit={
            <>
              <PanelChrome title="Boundary layer" onDelete={noop} onDone={noop} card>
                {BODY}
              </PanelChrome>
              <Parts pair="PanelChrome/card" side="kit" parts={{ root: '.mgk-panel' }} />
            </>
          }
        />
      </Group>
      <Group title="StatusBlock (core, then kit)">
        <CorePair
          pair="StatusBlock/running"
          core={
            <div className="mat-panel-body">
              <div className="mesh-finished" data-kit-part="root">
                <div className="mat-k" data-kit-part="title">
                  Generating mesh
                </div>
                <div className="mesh-finished-line" data-kit-part="line">
                  Snapping to the surface…
                </div>
                <div className="mesh-elapsed" data-kit-part="elapsed">
                  0:42
                </div>
              </div>
            </div>
          }
          kit={
            <>
              <div className="mat-panel-body">
                <StatusBlock title="Generating mesh" line="Snapping to the surface…" elapsed="0:42" />
              </div>
              <Parts
                pair="StatusBlock/running"
                side="kit"
                parts={{ root: '.mgk-status', title: '.mgk-status-title', line: '.mgk-status-line', elapsed: '.mgk-status-elapsed' }}
              />
            </>
          }
        />
        <CorePair
          pair="StatusBlock/done"
          core={
            <div className="mat-panel-body">
              <div className="mesh-finished" data-kit-part="root">
                <div className="mat-k" data-kit-part="title">
                  Mesh ready
                </div>
                <div className="mesh-finished-line" data-kit-part="line">
                  48,213 cells / 52,907 nodes
                </div>
                <div className="mesh-finished-meta" data-kit-part="meta">
                  Standard · 0:42
                </div>
              </div>
            </div>
          }
          kit={
            <>
              <div className="mat-panel-body">
                <StatusBlock title="Mesh ready" line="48,213 cells / 52,907 nodes" meta={['Standard', '0:42']} />
              </div>
              <Parts
                pair="StatusBlock/done"
                side="kit"
                parts={{ root: '.mgk-status', title: '.mgk-status-title', line: '.mgk-status-line', meta: '.mgk-status-meta' }}
              />
            </>
          }
        />
        <CorePair
          pair="StatusBlock/eta"
          core={
            <div className="mat-panel-body">
              <div className="sim-finished" data-kit-part="root">
                <div className="mat-k">Running</div>
                <div className="mesh-finished-line">Iteration 120 of 500</div>
                <div className="mesh-elapsed">0:42</div>
                <div className="sim-eta" data-kit-part="eta">
                  ~1:10 left
                </div>
              </div>
            </div>
          }
          kit={
            <>
              <div className="mat-panel-body">
                <StatusBlock title="Running" line="Iteration 120 of 500" elapsed="0:42" eta="~1:10 left" />
              </div>
              <Parts pair="StatusBlock/eta" side="kit" parts={{ root: '.mgk-status', eta: '.mgk-status-eta' }} />
            </>
          }
        />
      </Group>
      <Group title="Toast (the workspace toast before H14, then kit)">
        <style>{WSX_TOAST_CSS}</style>
        <ToastPair kind="info" message="Saved the polar." />
        <ToastPair kind="success" message="Kit toast" />
        <ToastPair kind="error" message="Could not save: the study changed in another tab." />
      </Group>
    </>
  );
}
