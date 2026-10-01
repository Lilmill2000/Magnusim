// Outline icons: one path d (several M subpaths allowed) on a 24 viewBox,
// stroke currentColor, round caps and joins (design-language §6). Stroke 1.8
// in the tree and panels, 1.7 in the toolbar.
// Owner: UI-SHELL.
// SPDX-License-Identifier: GPL-3.0-or-later

export const ICONS = {
  /** The Part (same glyph as the manifest's study kind icon). */
  part: 'M4 8l8-4 8 4v8l-8 4-8-4z M4 8l8 4 8-4 M12 12v8',
  origin: 'M12 4v16 M4 12h16 M12 12m-2.5 0a2.5 2.5 0 1 0 5 0a2.5 2.5 0 1 0 -5 0',
  plane: 'M3 9l9-4 9 4-9 4z M3 9v6l9 4 9-4V9',
  point: 'M12 12m-2 0a2 2 0 1 0 4 0a2 2 0 1 0 -4 0 M12 3v5 M12 16v5 M3 12h5 M16 12h5',
  box: 'M3 9l5-4h13v10l-5 4H3z M3 9h13v10 M16 9l5-4',
  cylinder: 'M6 6a6 2.5 0 1 0 12 0a6 2.5 0 1 0 -12 0 M6 6v12a6 2.5 0 0 0 12 0V6',
  params: 'M4 19c2 0 3-1 3.5-4l1.5-8C9.5 4 10.5 3 12.5 3 M5 9h7 M13 12l6 7 M19 12l-6 7',
  undo: 'M9 14L4 9l5-5 M4 9h10.5a5.5 5.5 0 0 1 0 11H11',
  redo: 'M15 14l5-5-5-5 M20 9H9.5a5.5 5.5 0 0 0 0 11H13',
  folder: 'M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  eye: 'M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12z M12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0 -6 0',
  eyeOff:
    'M3 3l18 18 M10.6 6.1A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-3.2 3.9 M6.6 7.6C3.8 9.3 2 12 2 12s3.5 6 10 6a9.6 9.6 0 0 0 4.4-1.1 M9.9 10a3 3 0 0 0 4.1 4.1',
  pencil: 'M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z M13.8 6.9l3.2 3.2',
  trash: 'M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13',
  /** Fit (F): frame corners round a box. The viewport's house button is the core's
   *  "Fit model to viewport", which also turns to the home direction (shell.html:654-670). */
  fit: 'M4 9V4h5 M15 4h5v5 M20 15v5h-5 M9 20H4v-5 M9 9h6v6H9z',
  viewFront: 'M4 9h11v11H4z M4 9l4-5h12l-5 5 M15 20l5-5V4 M7 12.5h5 M7 16.5h5',
  viewTop: 'M4 9h11v11H4z M4 9l4-5h12l-5 5 M15 20l5-5V4 M8.5 6.5h7',
  viewRight: 'M4 9h11v11H4z M4 9l4-5h12l-5 5 M15 20l5-5V4 M17.5 8.5v6',
  viewIso: 'M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5',
  warning: 'M12 3.5L2.5 20h19z M12 10v4.5 M12 17.5v.01',
  error: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0 -18 0 M12 7.5v5.5 M12 16.5v.01',
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({ d, size = 14, stroke = 1.8, title, className }: { d: string; size?: number; stroke?: number; title?: string; className?: string }) {
  return (
    <svg className={className ? `cad-icon ${className}` : 'cad-icon'} viewBox="0 0 24 24" width={size} height={size} aria-hidden={title ? undefined : true} focusable="false">
      {title ? <title>{title}</title> : null}
      <path d={d} fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
