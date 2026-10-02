/**
 * Page only (page.tsx): the core's own buttons beside their kit twins. The
 * parity gate compares each named part of a pair over a fixed property set
 * and expects no difference. Core files may import core modules and the kit.
 */
import type { ReactNode } from 'react';
import { Button } from '../../../plugin-ui';
import { Group, SPECIMEN_BOX } from './Foundation';

const LABEL = {
  display: 'block',
  margin: '0 0 4px',
  fontFamily: 'var(--mg-font-mono)',
  fontSize: 11,
  lineHeight: 1.3,
  color: 'var(--mg-text-muted)',
} as const;

/**
 * One kit-vs-core pair: the core box (data-kit-core-pair) and the kit box
 * (data-kit-core-kit), the same wrapper markup on both. Each compared element
 * carries data-kit-part="<name>" on both sides.
 */
export function CorePair({ pair, core, kit }: { pair: string; core: ReactNode; kit: ReactNode }) {
  return (
    <div style={{ display: 'block', marginBottom: 12 }}>
      <div style={LABEL}>{pair}</div>
      <div data-kit-core-pair={pair} style={SPECIMEN_BOX}>
        {core}
      </div>
      <div style={{ display: 'block', height: 4 }} />
      <div data-kit-core-kit={pair} style={SPECIMEN_BOX}>
        {kit}
      </div>
    </div>
  );
}

const root = { 'data-kit-part': 'root' } as const;

export function FoundationCore() {
  return (
    <Group title="Button (core, then kit)">
      <CorePair
        pair="Button/primary"
        core={
          <button type="button" className="fp-btn fp-btn-primary" data-kit-part="root">
            Generate
          </button>
        }
        kit={
          <Button variant="primary" block attrs={root}>
            Generate
          </Button>
        }
      />
      <CorePair
        pair="Button/primary-disabled"
        core={
          <button type="button" className="fp-btn fp-btn-primary" data-kit-part="root" disabled>
            Generate
          </button>
        }
        kit={
          <Button variant="primary" block disabled attrs={root}>
            Generate
          </Button>
        }
      />
      <CorePair
        pair="Button/secondary"
        core={
          <button type="button" className="fp-btn" data-kit-part="root">
            Cancel
          </button>
        }
        kit={<Button attrs={root}>Cancel</Button>}
      />
      <CorePair
        pair="Button/secondary-disabled"
        core={
          <button type="button" className="fp-btn" data-kit-part="root" disabled>
            Cancel
          </button>
        }
        kit={
          <Button disabled attrs={root}>
            Cancel
          </Button>
        }
      />
      <CorePair
        pair="Button/neutral"
        core={
          <button type="button" className="js-btn" data-kit-part="root">
            Done
          </button>
        }
        kit={
          <Button variant="neutral" attrs={root}>
            Done
          </Button>
        }
      />
      <CorePair
        pair="Button/link"
        core={
          <button type="button" className="mat-clear-link" data-kit-part="root">
            Delete
          </button>
        }
        kit={
          <Button variant="link" attrs={root}>
            Delete
          </Button>
        }
      />
    </Group>
  );
}
