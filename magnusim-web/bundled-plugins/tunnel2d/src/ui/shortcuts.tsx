// The tunnel's keyboard shortcuts: one list, shown by "?" (and the toolbar's Shortcuts
// button), the same one the README gives.
// SPDX-License-Identifier: GPL-3.0-or-later
import { Button } from '@magnusim/plugin-ui';
import { useEffect, useRef } from 'react';
import { SHORTCUTS } from '../app/shortcuts';

export function ShortcutsHelp({ onClose }: { onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    box.current?.focus();
  }, []);
  return (
    <div
      className="t2d-shortcuts"
      role="dialog"
      aria-label="Keyboard shortcuts"
      tabIndex={-1}
      ref={box}
      data-t2d-shortcuts
      onKeyDown={(e) => {
        if (e.key === 'Escape' || e.key === '?') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="t2d-shortcuts-head">
        <span>Keyboard shortcuts</span>
        <Button variant="neutral" onClick={onClose} attrs={{ 'data-t2d-shortcuts-close': '1' }}>
          Close
        </Button>
      </div>
      <table>
        <tbody>
          {SHORTCUTS.map((s) => (
            <tr key={s.keys}>
              <td>
                <kbd>{s.keys}</kbd>
              </td>
              <td>{s.what}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
