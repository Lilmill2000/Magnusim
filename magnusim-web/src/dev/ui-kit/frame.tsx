/**
 * The frame side of the UI kit dev sheet (/plugin-sdk/ui-kit-sheet.js). It
 * runs in a sandboxed frame like a plugin workspace, on the shipped
 * /plugin-sdk/plugin-ui.js through the import map, and tells the page its
 * height. It imports the Sheet only: no core module and no kit source.
 */
import * as kit from '@magnusim/plugin-ui';
import { useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Sheet } from './Sheet';

function Frame() {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const post = () => window.parent.postMessage({ type: 'kit-sheet-height', height: el.offsetHeight }, '*');
    const observer = new ResizeObserver(post);
    observer.observe(el);
    post();
    let live = true;
    void document.fonts.ready.then(() => {
      if (!live) return;
      el.setAttribute('data-kit-sheet-ready', 'frame');
      post();
    });
    return () => {
      live = false;
      observer.disconnect();
    };
  }, []);
  return (
    <div ref={ref} style={{ padding: 8 }}>
      <Sheet kit={kit} side="frame" />
    </div>
  );
}

const root = document.getElementById('root');
if (root) createRoot(root).render(<Frame />);
