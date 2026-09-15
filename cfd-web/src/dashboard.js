/**
 * Homepage — project library.
 * Lists real projects from /api/projects. Inspired by a workbench dashboard
 * (folders, cards, search, create) without cloning SimScale chrome.
 */

import { initSetupWizard } from './setup-wizard.js';

function $(id) {
  return document.getElementById(id);
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatWhen(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

function formatCells(n) {
  if (n == null || !Number.isFinite(Number(n))) return null;
  const v = Number(n);
  if (v >= 1e6) return `${(v / 1e6).toFixed(2)}M cells`;
  if (v >= 1000) return `${Math.round(v / 100) / 10}k cells`;
  return `${v} cells`;
}

function formatBusyLabel(verb, startedAt) {
  const start = Date.parse(startedAt || '');
  if (!Number.isFinite(start)) return `${verb}…`;
  const sec = Math.max(0, Math.floor((Date.now() - start) / 1000));
  const mm = Math.floor(sec / 60);
  const ss = String(sec % 60).padStart(2, '0');
  return mm >= 60
    ? `${verb} ${Math.floor(mm / 60)}h ${String(mm % 60).padStart(2, '0')}m`
    : `${verb} ${mm}:${ss}`;
}

function initials(title) {
  const parts = String(title || 'P')
    .trim()
    .split(/[\s-_]+/)
    .filter(Boolean);
  if (!parts.length) return 'P';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function projectHash(id) {
  return `#/p/${encodeURIComponent(id)}`;
}

export function parseHomeRoute() {
  const h = String(location.hash || '').replace(/^#/, '');
  const proj = h.match(/^\/p\/([^/]+)$/);
  if (proj) return { view: 'workbench', projectId: decodeURIComponent(proj[1]), filter: null };
  const folder = h.match(/^\/folder\/(.+)$/);
  if (folder) {
    return { view: 'home', projectId: null, filter: `folder:${decodeURIComponent(folder[1])}` };
  }
  if (h === '/recent') return { view: 'home', projectId: null, filter: 'recent' };
  return { view: 'home', projectId: null, filter: 'all' };
}

export function shouldStartOnHome() {
  return parseHomeRoute().view === 'home';
}

/** Persist the `#/p/<id>` project as server-active so /api/mesh and job state match the URL. */
export async function activateHashProject() {
  const route = parseHomeRoute();
  if (route.view !== 'workbench' || !route.projectId) return null;
  const r = await fetch('/api/project/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ project_id: route.projectId }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('[CFD] hash project open', j);
    return null;
  }
  return route.projectId;
}

const ROOT_FOLDER = 'My Projects';

const state = {
  projects: [],
  folders: [],
  activeId: null,
  filter: 'all', // all | recent | folder:<name>
  query: '',
  sort: 'modified',
  selectedId: null,
  selectedFolder: null,
  draggingId: null,
  justDropped: false,
};

function subfolderNames() {
  return [...new Set(state.folders.filter((n) => n && n !== ROOT_FOLDER))].sort((a, b) =>
    a.localeCompare(b),
  );
}

function folderLocation(name) {
  const folder = String(name || ROOT_FOLDER).trim() || ROOT_FOLDER;
  if (folder === ROOT_FOLDER) return ROOT_FOLDER;
  return `${ROOT_FOLDER} / ${folder}`;
}

function currentFolderName() {
  if (state.filter.startsWith('folder:')) return state.filter.slice(7);
  return '';
}

function visibleProjects() {
  let list = state.projects.slice();
  if (state.filter === 'recent') {
    list = list.slice(0, 8);
  } else if (state.filter.startsWith('folder:')) {
    const folder = state.filter.slice(7);
    list = list.filter((p) => p.folder === folder);
  }
  const q = state.query.trim().toLowerCase();
  if (q) {
    list = list.filter((p) => {
      const hay = [p.title, p.description, p.folder, p.geometry_name, p.analysis, p.category]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(q);
    });
  }
  if (state.sort === 'name') {
    list.sort((a, b) => String(a.title).localeCompare(String(b.title)));
  } else {
    list.sort((a, b) =>
      String(b.updated_at || b.created_at || '').localeCompare(String(a.updated_at || a.created_at || '')),
    );
  }
  return list;
}

function folderCounts() {
  const counts = {};
  for (const p of state.projects) {
    const f = p.folder || 'My Projects';
    counts[f] = (counts[f] || 0) + 1;
  }
  return counts;
}

function applyHomeFilterFromRoute() {
  const route = parseHomeRoute();
  if (route.view !== 'home') return;
  state.filter = route.filter || 'all';
  if (state.filter.startsWith('folder:')) state.selectedFolder = state.filter.slice(7);
  else if (!state.selectedId) state.selectedFolder = null;
}

function hashForFilter(filter) {
  if (filter === 'recent') return '#/recent';
  if (filter.startsWith('folder:')) return `#/folder/${encodeURIComponent(filter.slice(7))}`;
  return '#/';
}

export function showHome() {
  const home = $('home');
  const app = $('app');
  if (home) home.hidden = false;
  if (app) app.hidden = true;
  document.body.classList.add('on-home');
  document.body.classList.remove('on-workbench');
  if (parseHomeRoute().view === 'workbench') {
    history.replaceState(null, '', '#/');
  }
  applyHomeFilterFromRoute();
  document.title = 'CFD Desk — Projects';
  refreshHome().then(() => startHomeActivityPoll()).catch(() => {});
}

export function showWorkbench() {
  if (typeof window.__CFD_APPLY_WB_STAGE__ === 'function') {
    window.__CFD_APPLY_WB_STAGE__();
  }
  const home = $('home');
  const app = $('app');
  if (home) home.hidden = true;
  if (app) app.hidden = false;
  document.body.classList.remove('on-home');
  document.body.classList.add('on-workbench');
  document.title = 'CFD Desk';
  stopHomeActivityPoll();
  requestAnimationFrame(() => {
    window.__CFD_RESIZE_VIEWER__?.();
  });
}

export async function openProject(id, { reloadIfNeeded = true } = {}) {
  const r = await fetch('/api/project/open', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ project_id: id }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Could not open project');
  location.hash = projectHash(id);
  const already = window.__CFD_W16__ && window.__CFD_W16__.project && window.__CFD_W16__.project.id === id;
  if (already || !reloadIfNeeded) {
    showWorkbench();
    return j;
  }
  location.reload();
  return j;
}

async function loadCatalog() {
  const r = await fetch('/api/projects');
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Could not list projects');
  state.projects = Array.isArray(j.projects) ? j.projects : [];
  state.folders = Array.isArray(j.folders) ? j.folders : [];
  state.activeId = j.active_project_id || null;
  return j;
}

function renderNav() {
  const nav = $('home-folder-list');
  if (!nav) return;
  const counts = folderCounts();
  const rootKey = `folder:${ROOT_FOLDER}`;
  const rootOn = state.filter === rootKey ? ' is-active' : '';
  const children = subfolderNames()
    .map((name) => {
      const key = `folder:${name}`;
      const on = state.filter === key ? ' is-active' : '';
      return (
        `<a href="${escapeHtml(hashForFilter(key))}" class="home-nav-item home-nav-child${on}" data-filter="${escapeHtml(key)}" data-drop-folder="${escapeHtml(name)}">` +
        `<span class="home-nav-label">${escapeHtml(name)}</span>` +
        `<span class="home-nav-count">${counts[name] || 0}</span>` +
        `</a>`
      );
    })
    .join('');
  nav.innerHTML =
    `<a href="${escapeHtml(hashForFilter(rootKey))}" class="home-nav-item home-nav-root${rootOn}" data-filter="${escapeHtml(rootKey)}" data-drop-folder="${escapeHtml(ROOT_FOLDER)}">` +
    `<span class="home-nav-label">${escapeHtml(ROOT_FOLDER)}</span>` +
    `<span class="home-nav-count">${counts[ROOT_FOLDER] || 0}</span>` +
    `</a>` +
    `<div class="home-nav-children">${children}</div>`;
  $('home-nav-all')?.classList.toggle('is-active', state.filter === 'all');
  $('home-nav-recent')?.classList.toggle('is-active', state.filter === 'recent');
  const allCount = $('home-all-count');
  if (allCount) allCount.textContent = String(state.projects.length);
}

function renderBreadcrumb() {
  const el = $('home-crumb');
  if (!el) return;
  if (state.filter === 'recent') {
    el.innerHTML =
      `<button type="button" class="home-crumb-link" data-crumb="all">My Projects</button>` +
      `<span class="home-crumb-sep"> / </span><span>Recent</span>`;
  } else if (state.filter.startsWith('folder:')) {
    const name = state.filter.slice(7);
    if (name === ROOT_FOLDER) {
      el.textContent = ROOT_FOLDER;
    } else {
      el.innerHTML =
        `<button type="button" class="home-crumb-link" data-crumb="root">${escapeHtml(ROOT_FOLDER)}</button>` +
        `<span class="home-crumb-sep"> / </span><span>${escapeHtml(name)}</span>`;
    }
  } else {
    el.textContent = ROOT_FOLDER;
  }
}

function renderCards() {
  const grid = $('home-grid');
  const empty = $('home-empty');
  if (!grid) return;
  const projects = visibleProjects();
  const counts = folderCounts();
  const showFolderTiles =
    !state.query.trim() && (state.filter === 'all' || state.filter === `folder:${ROOT_FOLDER}`);
  const folderTiles = showFolderTiles
    ? subfolderNames()
        .map((name) => {
          const n = counts[name] || 0;
          const on = state.selectedFolder === name && !state.selectedId ? ' is-selected' : '';
          return (
            `<a class="home-folder-tile${on}" href="${escapeHtml(hashForFilter(`folder:${name}`))}" data-open-folder="${escapeHtml(name)}" data-drop-folder="${escapeHtml(name)}">` +
            `<span class="home-folder-glyph" aria-hidden="true"></span>` +
            `<span class="home-card-title">${escapeHtml(name)}</span>` +
            `<span class="home-card-meta">${n} project${n === 1 ? '' : 's'}</span>` +
            `</a>`
          );
        })
        .join('')
    : '';

  grid.innerHTML =
    folderTiles +
    projects
      .map((p) => {
        const on = state.selectedId === p.id ? ' is-selected' : '';
        const cells = formatCells(p.mesh_cells);
        const chips = [
          p.has_geometry ? `<span class="home-chip">Geometry</span>` : '',
          p.meshing
            ? `<span class="home-chip is-busy">${escapeHtml(formatBusyLabel('Meshing', p.mesh_started_at))}</span>`
            : p.has_mesh
              ? `<span class="home-chip">${cells || 'Mesh'}</span>`
              : '',
          p.simulating
            ? `<span class="home-chip is-busy">${escapeHtml(formatBusyLabel('Simulating', p.run_started_at))}</span>`
            : p.has_run
              ? `<span class="home-chip is-run">${escapeHtml(p.run_status || 'Run')}</span>`
              : '',
        ]
          .filter(Boolean)
          .join('');
        const thumbInner = p.thumb_url
          ? `<img class="home-thumb-img" src="${escapeHtml(p.thumb_url)}" alt="" loading="lazy" data-fallback="${escapeHtml(initials(p.title))}">`
          : `<span>${escapeHtml(initials(p.title))}</span>`;
        return (
          `<article class="home-card${on}" data-project-id="${escapeHtml(p.id)}" tabindex="0" draggable="true">` +
          `<div class="home-thumb">${thumbInner}</div>` +
          `<div class="home-card-body">` +
          `<h3 class="home-card-title">${escapeHtml(p.title)}</h3>` +
          `<p class="home-card-meta">${escapeHtml(formatWhen(p.updated_at))}</p>` +
          `<p class="home-card-id">${escapeHtml(p.id)}</p>` +
          `<div class="home-chips">${chips || '<span class="home-chip is-muted">Empty</span>'}</div>` +
          `<p class="home-card-folder">${escapeHtml(folderLocation(p.folder))}</p>` +
          `</div></article>`
        );
      })
      .join('');

  if (empty) {
    const none = projects.length === 0 && !folderTiles;
    empty.hidden = !none;
    if (none && state.filter.startsWith('folder:')) {
      empty.textContent = `No projects in ${state.filter.slice(7)} yet. Create one to start.`;
    } else if (none) {
      empty.textContent = 'No projects here yet. Create one to start.';
    }
  }
  grid.querySelectorAll('.home-thumb-img').forEach((img) => {
    img.addEventListener('error', () => {
      const span = document.createElement('span');
      span.textContent = img.getAttribute('data-fallback') || 'P';
      img.replaceWith(span);
    });
  });
}

function selectedProject() {
  return state.projects.find((p) => p.id === state.selectedId) || null;
}

function showDeleteFoot(show) {
  const foot = $('home-detail-foot');
  if (foot) foot.hidden = !show;
}

function renderDetail() {
  const box = $('home-detail-body');
  if (!box) return;
  const p = selectedProject();
  if (p) {
    const cells = formatCells(p.mesh_cells);
    box.innerHTML =
      `<div class="home-detail-kicker">Project</div>` +
      `<div class="home-detail-title-row">` +
      `<h3>${escapeHtml(p.title)}</h3>` +
      `<button type="button" class="home-edit" id="home-edit-project" title="Edit project" aria-label="Edit project">` +
      `<svg viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" focusable="false">` +
      `<g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z"/>` +
      `<path d="M13.8 6.9l3.2 3.2"/>` +
      `</g></svg></button></div>` +
      `<p class="home-detail-desc">${escapeHtml(p.description || 'No description.')}</p>` +
      `<dl class="home-dl">` +
      `<div><dt>Folder</dt><dd>${escapeHtml(folderLocation(p.folder))}</dd></div>` +
      `<div><dt>Category</dt><dd>${escapeHtml(p.category || '—')}</dd></div>` +
      `<div><dt>Units</dt><dd>${escapeHtml(p.units || '—')}</dd></div>` +
      `<div><dt>Geometry</dt><dd>${escapeHtml(p.geometry_name || (p.has_geometry ? 'Imported' : 'None'))}</dd></div>` +
      `<div><dt>Analysis</dt><dd>${escapeHtml(p.analysis || '—')}</dd></div>` +
      `<div><dt>Mesh</dt><dd>${escapeHtml(
        p.meshing
          ? formatBusyLabel('Meshing', p.mesh_started_at)
          : cells || (p.has_mesh ? 'Generated' : 'None'),
      )}</dd></div>` +
      `<div><dt>Last run</dt><dd>${escapeHtml(
        p.simulating ? formatBusyLabel('Simulating', p.run_started_at) : p.run_status || '—',
      )}</dd></div>` +
      `<div><dt>Modified</dt><dd>${escapeHtml(formatWhen(p.updated_at))}</dd></div>` +
      `</dl>` +
      `<button type="button" class="home-btn-primary" id="home-open-selected">Open project</button>`;
    $('home-open-selected')?.addEventListener('click', () => {
      openProject(p.id).catch((e) => console.error('[CFD home] open', e));
    });
    $('home-edit-project')?.addEventListener('click', () => openEditModal(p));
    showDeleteFoot(true);
    return;
  }
  showDeleteFoot(false);
  if (state.selectedFolder || state.filter.startsWith('folder:')) {
    const name = state.selectedFolder || state.filter.slice(7);
    const n = state.projects.filter((x) => x.folder === name).length;
    box.innerHTML =
      `<div class="home-detail-kicker">Folder</div>` +
      `<h3>${escapeHtml(name)}</h3>` +
      `<p class="home-detail-desc">${n} project${n === 1 ? '' : 's'} in this folder.</p>`;
    return;
  }
  box.innerHTML =
    `<div class="home-detail-kicker">Library</div>` +
    `<h3>Projects</h3>` +
    `<p class="home-detail-desc">Select a project to see details, or create a new one to start a simulation.</p>`;
}

function render() {
  renderNav();
  renderBreadcrumb();
  renderCards();
  renderDetail();
}

let homeActivityTimer = null;

function stopHomeActivityPoll() {
  if (homeActivityTimer) {
    clearInterval(homeActivityTimer);
    homeActivityTimer = null;
  }
}

function catalogHasLiveJob() {
  return (state.projects || []).some((p) => p.meshing || p.simulating);
}

function startHomeActivityPoll() {
  stopHomeActivityPoll();
  const home = $('home');
  if (!home || home.hidden || document.hidden) return;
  // Idle home must not keep Vite walking disk. Poll only while a mesh or
  // solve is actually running.
  if (!catalogHasLiveJob()) return;
  homeActivityTimer = setInterval(() => {
    const el = $('home');
    if (!el || el.hidden || document.hidden) {
      stopHomeActivityPoll();
      return;
    }
    refreshHome()
      .then(() => {
        if (!catalogHasLiveJob()) stopHomeActivityPoll();
      })
      .catch(() => {});
  }, 2500);
}

export async function refreshHome() {
  try {
    await loadCatalog();
    if (state.selectedId && !state.projects.some((p) => p.id === state.selectedId)) {
      state.selectedId = null;
    }
    render();
  } catch (e) {
    console.error('[CFD home] refresh', e);
    const empty = $('home-empty');
    if (empty) {
      empty.hidden = false;
      empty.textContent = 'Could not load projects from disk.';
    }
  }
}

function selectProject(id) {
  state.selectedId = id;
  state.selectedFolder = null;
  const grid = $('home-grid');
  if (grid) {
    grid.querySelectorAll('.home-card').forEach((el) => {
      el.classList.toggle('is-selected', el.getAttribute('data-project-id') === id);
    });
    grid.querySelectorAll('.home-folder-tile').forEach((el) => el.classList.remove('is-selected'));
  }
  renderDetail();
}

function setFilter(filter) {
  state.filter = filter;
  state.selectedId = null;
  if (filter.startsWith('folder:')) state.selectedFolder = filter.slice(7);
  else state.selectedFolder = null;
  const next = hashForFilter(filter);
  if (location.hash !== next) location.hash = next;
  render();
}

const NEW_FOLDER_VALUE = '__new__';

const projectModal = {
  mode: 'create',
  id: null,
};

function setSelectValue(sel, value) {
  if (!sel || value == null) return;
  const v = String(value);
  if (v && ![...sel.options].some((o) => o.value === v)) {
    const opt = document.createElement('option');
    opt.value = v;
    opt.textContent = v;
    sel.appendChild(opt);
  }
  sel.value = v;
}

function paintProjectModalChrome() {
  const heading = $('np-heading');
  const btn = $('np-create');
  if (projectModal.mode === 'edit') {
    if (heading) heading.textContent = 'Edit project';
    if (btn) btn.textContent = 'Save';
    return;
  }
  if (heading) heading.textContent = 'Create new project';
  if (btn) btn.textContent = 'Create';
}

function fillFolderSelect(preferred) {
  const sel = $('np-folder');
  if (!sel) return;
  const names = [ROOT_FOLDER, ...subfolderNames()];
  const pick = names.includes(preferred) ? preferred : ROOT_FOLDER;
  sel.innerHTML =
    names.map((n) => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`).join('') +
    `<option value="${NEW_FOLDER_VALUE}">Create new folder…</option>`;
  sel.value = pick;
  toggleNewFolderField();
}

function toggleNewFolderField() {
  const sel = $('np-folder');
  const wrap = $('np-folder-new-wrap');
  const isNew = !!sel && sel.value === NEW_FOLDER_VALUE;
  if (wrap) wrap.hidden = !isNew;
  if (isNew) {
    const input = $('np-folder-new');
    if (input) {
      input.value = '';
      input.focus();
    }
  }
}

export async function prepareCreateModal(existing) {
  if (!state.folders.length && !state.projects.length) {
    try {
      await loadCatalog();
    } catch (e) {
      console.warn('[CFD home] folders', e);
    }
  }
  const title = $('np-title');
  const desc = $('np-description');
  const editing = existing && existing.id;
  projectModal.mode = editing ? 'edit' : 'create';
  projectModal.id = editing ? existing.id : null;
  if (title) {
    title.placeholder = 'Vortex separator — incompressible';
    title.value = editing ? existing.title || '' : '';
  }
  if (desc) {
    desc.placeholder = 'What you are trying to learn from this run';
    desc.value = editing ? existing.description || '' : '';
  }
  if (editing) {
    setSelectValue($('np-category'), existing.category || 'Other');
    setSelectValue($('np-units'), existing.units || 'Metric');
    fillFolderSelect(existing.folder || ROOT_FOLDER);
  } else {
    setSelectValue($('np-category'), 'Fluid dynamics');
    const prefUnits =
      (window.__CFD_PREFS__ && window.__CFD_PREFS__.units) || 'Metric';
    setSelectValue($('np-units'), /imperial/i.test(String(prefUnits)) ? 'Imperial' : 'Metric');
    fillFolderSelect(currentFolderName() || ROOT_FOLDER);
  }
  paintProjectModalChrome();
}

export async function submitProjectModal() {
  const title = ($('np-title')?.value || '').trim();
  if (!title) {
    $('np-title')?.focus();
    return { ok: false, error: 'title required' };
  }
  const folderGot = await folderValueFromCreateModal();
  if (!folderGot.ok) return folderGot;
  const fields = {
    title,
    description: $('np-description')?.value || '',
    category: $('np-category')?.value || 'Other',
    units: $('np-units')?.value || 'Metric',
    folder: folderGot.folder,
  };
  if (projectModal.mode === 'edit' && projectModal.id) {
    const id = projectModal.id;
    const r = await fetch('/api/project/update', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ project_id: id, ...fields }),
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j.error || 'Could not update project' };
    const live = window.__CFD_W16__ && window.__CFD_W16__.project;
    if (live && live.id === id) {
      live.title = fields.title;
      live.description = fields.description;
      live.category = fields.category;
      live.units = fields.units;
      live.folder = fields.folder;
    }
    projectModal.mode = 'create';
    projectModal.id = null;
    paintProjectModalChrome();
    await refreshHome();
    selectProject(id);
    return { ok: true, mode: 'edit', project: j.project };
  }
  return { ok: true, mode: 'create', fields };
}

function openEditModal(project) {
  const modal = $('modal-new-project');
  prepareCreateModal(project).then(() => {
    if (window.__CFD_OPEN_NEW_PROJECT_MODAL__) {
      window.__CFD_OPEN_NEW_PROJECT_MODAL__(project);
      return;
    }
    if (modal) {
      modal.hidden = false;
      $('np-title')?.focus();
    }
  });
}

export async function folderValueFromCreateModal() {
  const sel = $('np-folder');
  const value = sel ? String(sel.value || '') : '';
  if (value === NEW_FOLDER_VALUE) {
    const name = ($('np-folder-new')?.value || '').trim();
    if (!name) {
      $('np-folder-new')?.focus();
      return { ok: false, error: 'folder name required' };
    }
    const r = await fetch('/api/folders', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name }),
    });
    const j = await r.json();
    if (!r.ok) return { ok: false, error: j.error || 'Could not create folder' };
    if (!state.folders.includes(name)) state.folders = [...state.folders, name];
    return { ok: true, folder: name };
  }
  const folder = (value || ROOT_FOLDER).trim() || ROOT_FOLDER;
  return { ok: true, folder };
}

function openCreateModalFromHome() {
  prepareCreateModal().then(() => {
    window.__CFD_OPEN_NEW_PROJECT_MODAL__?.();
  });
}

function openFolderModal() {
  const modal = $('modal-new-folder');
  if (!modal) return;
  modal.hidden = false;
  const input = $('nf-name');
  if (input) {
    input.value = '';
    input.focus();
  }
}

function closeFolderModal() {
  const modal = $('modal-new-folder');
  if (modal) modal.hidden = true;
}

const deleteConfirm = {
  id: null,
  title: '',
  step: 0,
};

function closeDeleteModal() {
  const modal = $('modal-delete-project');
  if (modal) modal.hidden = true;
  deleteConfirm.id = null;
  deleteConfirm.title = '';
  deleteConfirm.step = 0;
  const btn = $('dp-confirm');
  if (btn) {
    btn.disabled = false;
    btn.textContent = 'Yes';
  }
}

function paintDeleteModal() {
  const heading = $('dp-heading');
  const copy = $('dp-copy');
  const btn = $('dp-confirm');
  const title = deleteConfirm.title || 'this project';
  if (deleteConfirm.step === 1) {
    if (heading) heading.textContent = 'Delete project?';
    if (copy) {
      copy.textContent = `Are you sure you want to delete “${title}”? This removes the project from your library.`;
    }
    if (btn) btn.textContent = 'Yes';
    return;
  }
  if (heading) heading.textContent = 'Permanently delete?';
  if (copy) {
    copy.textContent =
      `This cannot be undone. Geometry, mesh, and results for “${title}” will be wiped from disk.`;
  }
  if (btn) btn.textContent = 'Yes, delete';
}

function openDeleteModal() {
  const p = selectedProject();
  if (!p) return;
  deleteConfirm.id = p.id;
  deleteConfirm.title = p.title || p.id;
  deleteConfirm.step = 1;
  paintDeleteModal();
  const modal = $('modal-delete-project');
  if (modal) modal.hidden = false;
}

async function confirmDeleteStep() {
  if (!deleteConfirm.id) return;
  if (deleteConfirm.step === 1) {
    deleteConfirm.step = 2;
    paintDeleteModal();
    return;
  }
  const btn = $('dp-confirm');
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Deleting…';
  }
  const id = deleteConfirm.id;
  const r = await fetch('/api/project/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ project_id: id }),
  });
  const j = await r.json();
  if (!r.ok) {
    const copy = $('dp-copy');
    if (copy) copy.textContent = j.error || 'Could not delete project.';
    if (btn) {
      btn.disabled = false;
      btn.textContent = 'Yes, delete';
    }
    throw new Error(j.error || 'Could not delete project');
  }
  if (state.selectedId === id) state.selectedId = null;
  state.projects = state.projects.filter((p) => p.id !== id);
  closeDeleteModal();
  await refreshHome();
}

function dropFolderFromEl(el) {
  if (!el) return '';
  return (
    el.getAttribute('data-drop-folder') ||
    el.getAttribute('data-open-folder') ||
    (String(el.getAttribute('data-filter') || '').startsWith('folder:')
      ? el.getAttribute('data-filter').slice(7)
      : '')
  );
}

async function moveProjectToFolder(id, folder) {
  const dest = String(folder || ROOT_FOLDER).trim() || ROOT_FOLDER;
  const r = await fetch('/api/project/move', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ project_id: id, folder: dest }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Could not move project');
  const local = state.projects.find((p) => p.id === id);
  if (local) {
    local.folder = dest;
    local.updated_at = new Date().toISOString();
  }
  await refreshHome();
  return j;
}

function wireDragDrop() {
  const home = $('home');
  if (!home) return;
  home.addEventListener('dragstart', (e) => {
    const card = e.target.closest('.home-card[data-project-id]');
    if (!card) return;
    const id = card.getAttribute('data-project-id');
    state.draggingId = id;
    e.dataTransfer.setData('text/cfd-project', id);
    e.dataTransfer.setData('text/plain', id);
    e.dataTransfer.effectAllowed = 'move';
    card.classList.add('is-dragging');
  });
  home.addEventListener('dragend', () => {
    home.querySelectorAll('.is-dragging').forEach((el) => el.classList.remove('is-dragging'));
    home.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    setTimeout(() => {
      state.draggingId = null;
    }, 0);
  });
  home.addEventListener('dragover', (e) => {
    const dest = e.target.closest('[data-drop-folder]');
    if (!dest || !state.draggingId) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    home.querySelectorAll('.is-drop-target').forEach((el) => el.classList.remove('is-drop-target'));
    dest.classList.add('is-drop-target');
  });
  home.addEventListener('drop', (e) => {
    const dest = e.target.closest('[data-drop-folder]');
    if (!dest) return;
    e.preventDefault();
    dest.classList.remove('is-drop-target');
    const id = e.dataTransfer.getData('text/cfd-project') || e.dataTransfer.getData('text/plain') || state.draggingId;
    const folder = dropFolderFromEl(dest);
    if (!id || !folder) return;
    state.justDropped = true;
    setTimeout(() => {
      state.justDropped = false;
    }, 80);
    moveProjectToFolder(id, folder).catch((err) => console.error('[CFD home] move', err));
  });
  home.addEventListener(
    'click',
    (e) => {
      if (!state.justDropped) return;
      e.preventDefault();
      e.stopPropagation();
    },
    true,
  );
}

async function createFolderFromModal() {
  const name = ($('nf-name')?.value || '').trim();
  if (!name) return;
  const r = await fetch('/api/folders', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ name }),
  });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'Could not create folder');
  closeFolderModal();
  setFilter(`folder:${name}`);
  await refreshHome();
}

function wireHome() {
  $('home-search')?.addEventListener('input', (e) => {
    state.query = e.target.value || '';
    render();
  });
  $('home-sort')?.addEventListener('change', (e) => {
    state.sort = e.target.value || 'modified';
    render();
  });
  $('home-nav-all')?.addEventListener('click', (e) => {
    e.preventDefault();
    setFilter('all');
  });
  $('home-nav-recent')?.addEventListener('click', (e) => {
    e.preventDefault();
    setFilter('recent');
  });
  $('home-folder-list')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (btn) {
      e.preventDefault();
      setFilter(btn.getAttribute('data-filter'));
    }
  });
  $('home-crumb')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-crumb="all"]')) setFilter('all');
    if (e.target.closest('[data-crumb="root"]')) setFilter(`folder:${ROOT_FOLDER}`);
  });
  $('home-grid')?.addEventListener('click', (e) => {
    if (state.draggingId || state.justDropped) return;
    const folderBtn = e.target.closest('[data-open-folder]');
    if (folderBtn) {
      e.preventDefault();
      setFilter(`folder:${folderBtn.getAttribute('data-open-folder')}`);
      return;
    }
    const card = e.target.closest('[data-project-id]');
    if (!card) return;
    const id = card.getAttribute('data-project-id');
    if (e.detail >= 2) {
      openProject(id).catch((err) => console.error('[CFD home] open', err));
      return;
    }
    selectProject(id);
  });
  $('np-folder')?.addEventListener('change', () => toggleNewFolderField());
  $('home-grid')?.addEventListener('dblclick', (e) => {
    const card = e.target.closest('[data-project-id]');
    if (!card) return;
    e.preventDefault();
    openProject(card.getAttribute('data-project-id')).catch((err) => console.error('[CFD home] open', err));
  });
  $('home-grid')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const card = e.target.closest('[data-project-id]');
    if (card) {
      openProject(card.getAttribute('data-project-id')).catch((err) => console.error('[CFD home] open', err));
    }
  });
  $('home-new-project')?.addEventListener('click', openCreateModalFromHome);
  $('home-new-folder')?.addEventListener('click', openFolderModal);
  $('nf-cancel')?.addEventListener('click', closeFolderModal);
  $('nf-backdrop')?.addEventListener('click', closeFolderModal);
  $('home-delete-project')?.addEventListener('click', openDeleteModal);
  $('dp-cancel')?.addEventListener('click', closeDeleteModal);
  $('dp-backdrop')?.addEventListener('click', closeDeleteModal);
  $('dp-confirm')?.addEventListener('click', () => {
    confirmDeleteStep().catch((e) => console.error('[CFD home] delete', e));
  });
  $('nf-create')?.addEventListener('click', () => {
    createFolderFromModal().catch((e) => console.error('[CFD home] folder', e));
  });
  $('home-mark')?.addEventListener('click', () => {
    setFilter('all');
    showHome();
  });
}

export function goHomeFromWorkbench(folder) {
  try {
    if (typeof window.__CFD_W15_APPLY__ === 'function') {
      window.__CFD_W15_APPLY__({ detach: true }).catch(() => {});
    }
  } catch (_) {}
  if (folder) location.hash = `#/folder/${encodeURIComponent(folder)}`;
  else location.hash = '#/';
  showHome();
}

let homeBooted = false;

export function initHome() {
  if (homeBooted) {
    if (shouldStartOnHome()) showHome();
    return;
  }
  homeBooted = true;
  wireHome();
  wireDragDrop();
  initSetupWizard().catch((e) => console.warn('[CFD] setup wizard', e));
  window.__CFD_HOME__ = {
    show: showHome,
    hide: showWorkbench,
    refresh: refreshHome,
    open: openProject,
    prepareCreateModal,
    folderValueFromCreateModal,
    submitProjectModal,
  };
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) stopHomeActivityPoll();
    else if ($('home') && !$('home').hidden) startHomeActivityPoll();
  });
  window.addEventListener('hashchange', () => {
    const route = parseHomeRoute();
    if (route.view === 'workbench') {
      if (route.projectId) {
        openProject(route.projectId).catch((e) => console.warn('[CFD home] hash open', e));
      } else {
        showWorkbench();
      }
      return;
    }
    applyHomeFilterFromRoute();
    const home = $('home');
    if (!home || home.hidden) showHome();
    else render();
  });
  if (shouldStartOnHome()) showHome();
  else {
    showWorkbench();
    activateHashProject().catch((e) => console.warn('[CFD home] hash project', e));
    loadCatalog().catch((e) => console.warn('[CFD home] catalog', e));
  }
}
