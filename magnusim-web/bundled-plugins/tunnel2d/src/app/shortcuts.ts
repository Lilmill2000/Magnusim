// The tunnel's keyboard shortcuts, one list: the help (src/ui/shortcuts.tsx) shows it, and a
// unit test holds the README's table to it.
// SPDX-License-Identifier: GPL-3.0-or-later
export const SHORTCUTS: { keys: string; what: string }[] = [
  { keys: 'Space', what: 'Run or pause the flow' },
  { keys: '.', what: 'Step the paused flow by one frame' },
  { keys: 'R', what: 'Reset the flow (bodies stay)' },
  { keys: 'F', what: 'Fit the tunnel in the view' },
  { keys: '1 – 7', what: 'Show: particles, vorticity, speed, pressure, schlieren, rheoscopic, none' },
  { keys: 'Ctrl+Z / Ctrl+Y', what: 'Undo / redo' },
  { keys: 'Arrows', what: 'Move the selected body (Shift: ten times as far)' },
  { keys: '[ / ]', what: 'Turn the selected body by 1° (Shift: 10°)' },
  { keys: 'Delete', what: 'Remove the selected body, rake or probe' },
  { keys: 'Esc', what: 'Clear the selection (in the sketcher: end what is being drawn, then the tool, then the sketcher)' },
  { keys: 'C', what: 'Save a picture of the view (PNG)' },
  { keys: 'Shift+C', what: 'Start or stop recording the view (WebM)' },
  { keys: '?', what: 'Show these shortcuts' },
];
