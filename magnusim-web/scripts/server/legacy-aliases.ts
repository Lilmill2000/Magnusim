/** Map today's URLs onto GET /api/filter/:key so main.js stays on legacy paths. */

export const FILTER_KEY_ALIASES: Record<string, string> = {
  'cut-plane': 'cut_plane',
  cut_plane: 'cut_plane',
  'iso-surface': 'iso_surface',
  iso_surface: 'iso_surface',
  'iso-volume': 'iso_volume',
  iso_volume: 'iso_volume',
  'plot-over-path': 'plot_over_path',
  plot_over_path: 'plot_over_path',
  'particle-trace': 'particle_trace',
  particle_trace: 'particle_trace',
  streamlines: 'particle_trace',
  inspect: 'inspect',
  inspect_point: 'inspect',
  fields: 'fields',
  surface_field: 'fields',
  'mesh-surface': 'mesh_surface',
  mesh_surface: 'mesh_surface',
  'mesh-section': 'mesh_section',
  mesh_section: 'mesh_section',
};

export const LEGACY_FILTER_PATHS: Array<{ path: string; key: string }> = [
  { path: '/api/cut-plane', key: 'cut_plane' },
  { path: '/api/cut-plane/meta', key: 'cut_plane' },
  { path: '/api/iso-surface', key: 'iso_surface' },
  { path: '/api/iso-surface/meta', key: 'iso_surface' },
  { path: '/api/iso-volume', key: 'iso_volume' },
  { path: '/api/iso-volume/meta', key: 'iso_volume' },
  { path: '/api/plot-over-path', key: 'plot_over_path' },
  { path: '/api/plot-over-path/meta', key: 'plot_over_path' },
  { path: '/api/particle-trace', key: 'particle_trace' },
  { path: '/api/particle-trace/meta', key: 'particle_trace' },
  { path: '/api/inspect', key: 'inspect' },
  { path: '/api/mesh-surface', key: 'mesh_surface' },
  { path: '/api/mesh/surface', key: 'mesh_surface' },
  { path: '/api/mesh-section', key: 'mesh_section' },
  { path: '/api/mesh/section', key: 'mesh_section' },
];

export function canonicalFilterKey(raw: string): string {
  const key = String(raw || '').trim();
  return FILTER_KEY_ALIASES[key] || FILTER_KEY_ALIASES[key.replace(/-/g, '_')] || key;
}

/**
 * A path as the scope check and the gate read it: the second segment's underscores read
 * as hyphens (the router adds an underscore alias of every hyphenated route).
 */
export function canonicalApiPath(pathname: string): string {
  const parts = String(pathname || '').split('/');
  if (parts.length > 2) parts[2] = parts[2].replace(/(?<=[A-Za-z0-9])_(?=[A-Za-z0-9])/g, '-');
  return parts.join('/');
}
