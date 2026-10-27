/**
 * Magnusim CAD's page (cad.html): Home, Settings, CAD's Part workspace and the Assistant,
 * with no simulation workbench. It shares Magnusim's page code (Home, Settings, the
 * workspace overlay, the dock) and never imports src/workbench/runtime.js: what that
 * gives Home and the overlay, this app's shell gives instead (src/cad-edition/shell.ts).
 */
import { installWorkspaceLeaveGuard } from '../workspace/leaveGuard';
import { createRoot } from 'react-dom/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import shellHtml from './shell.html?raw';
import '../theme/tokens.css';
import '../plugin-ui/kit.css';
import '../cad-edition/cad.css';
import { parseHomeRoute } from '../home/controller';
import { ensureDockRoot } from '../assistant/dock/root';
import { CadAppShell } from '../cad-edition/CadAppShell';
import { installCadShell } from '../cad-edition/shell';

// First, as in main.tsx: the workspace leave guard is the first hashchange listener.
installWorkspaceLeaveGuard();

const queryClient = new QueryClient();

function injectShell(): void {
  if (document.getElementById('app') && document.getElementById('home')) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = shellHtml;
  const root = document.getElementById('react-root');
  while (wrap.firstChild) document.body.insertBefore(wrap.firstChild, root);
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

function boot(): void {
  document.body.classList.add('edition-cad');
  injectShell();
  ensureReactRoot();
  ensureDockRoot();
  // The project page's place: in #app, where Magnusim's workbench is.
  const app = document.getElementById('app');
  if (app && !document.getElementById('cad-project')) {
    const page = document.createElement('div');
    page.id = 'cad-project';
    app.prepend(page);
  }
  installCadShell();
  const route = parseHomeRoute();
  document.body.classList.toggle('on-home', route.view === 'home');
  document.body.classList.toggle('on-workbench', route.view === 'workbench');
  document.documentElement.classList.add('cfd-ready');
  createRoot(ensureReactRoot()).render(
    <QueryClientProvider client={queryClient}>
      <CadAppShell />
    </QueryClientProvider>,
  );
}

boot();
