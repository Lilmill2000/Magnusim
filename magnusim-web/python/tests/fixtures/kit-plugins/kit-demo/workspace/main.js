// The Kit workspace (gate:h14-workspace-kit): kit controls in a sandboxed frame,
// from the shipped /plugin-sdk/plugin-ui.js through the import map.
import { connect } from '@magnusim/workspace';
import { createElement, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Button, Toggle } from '@magnusim/plugin-ui';

const ws = await connect();

function Kit() {
  const [on, setOn] = useState(false);
  return createElement(
    'div',
    null,
    createElement(
      Button,
      {
        variant: 'primary',
        attrs: { 'data-kit-button': '1' },
        onClick: () => void ws.ui.toast('Kit toast', { kind: 'success' }),
      },
      'Show a toast',
    ),
    createElement('div', { 'data-kit-toggle': '1' }, createElement(Toggle, { label: 'Kit switch', checked: on, onChange: setOn })),
  );
}

createRoot(document.getElementById('kit-root')).render(createElement(Kit));
