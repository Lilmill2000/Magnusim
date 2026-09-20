import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import shellHtml from './shell.html?raw';
import { AppShell } from './AppShell';
import { parseHomeRoute } from '../home/controller';

const queryClient = new QueryClient();

function injectShell(): void {
  if (document.getElementById('app') && document.getElementById('home')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = shellHtml;
  const body = document.body;
  const root = document.getElementById('react-root');
  while (wrap.firstChild) {
    body.insertBefore(wrap.firstChild, root);
  }
}

function ensureReactRoot(): HTMLElement {
  let el = document.getElementById('react-root');
  if (!el) {
    el = document.createElement('div');
    el.id = 'react-root';
    document.body.appendChild(el);
  }
  return el;
}

async function boot(): Promise<void> {
  injectShell();
  document.getElementById('left-tree')?.setAttribute('data-react-tree', '1');
  const route = parseHomeRoute();
  document.body.classList.toggle('on-home', route.view === 'home');
  document.body.classList.toggle('on-workbench', route.view === 'workbench');
  if (route.view === 'workbench') {
    const home = document.getElementById('home');
    const app = document.getElementById('app');
    if (home) home.hidden = true;
    if (app) app.hidden = false;
  }
  try {
    await import('../workbench/runtime.js');
  } catch (e) {
    console.error('[CFD] workbench runtime failed', e);
  }
  createRoot(ensureReactRoot()).render(
    <QueryClientProvider client={queryClient}>
      <AppShell />
    </QueryClientProvider>,
  );
}

void boot();
