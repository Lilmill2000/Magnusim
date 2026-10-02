/**
 * The dev sheet's Foundation section (Button, formatters, constants), and the
 * pieces every section uses to show a specimen.
 *
 * Sections render through the `kit` prop and import kit types only, so the
 * page (the app's copy) and the frame (/plugin-sdk/plugin-ui.js) run the same
 * code. Specimen children are text or kit markup only: the frame's base.css
 * styles the sheet's own p, lists and headings, the page does not.
 */
import type { CSSProperties, ReactNode } from 'react';

export type Kit = typeof import('../../../plugin-ui');

export interface SectionProps {
  kit: Kit;
  side: 'page' | 'frame';
}

/** The box a specimen sits in: block flow, fixed width, the same in page and frame. */
export const SPECIMEN_BOX: CSSProperties = {
  display: 'block',
  flex: 'none',
  width: 320,
  padding: 8,
  fontFamily: 'var(--mg-font)',
  fontSize: 12,
  lineHeight: 'normal',
  color: 'var(--mg-text-strong)',
  background: 'var(--mg-bg)',
};

const WRAP: CSSProperties = { display: 'block', marginBottom: 12 };
const LABEL: CSSProperties = {
  display: 'block',
  margin: '0 0 4px',
  fontFamily: 'var(--mg-font-mono)',
  fontSize: 11,
  lineHeight: 1.3,
  color: 'var(--mg-text-muted)',
};
const NOTE: CSSProperties = {
  display: 'block',
  width: 320,
  margin: '4px 0 0',
  fontFamily: 'var(--mg-font)',
  fontSize: 11,
  lineHeight: 1.35,
  color: 'var(--mg-text-muted)',
};
const GROUP_TITLE: CSSProperties = {
  display: 'block',
  margin: '16px 0 8px',
  fontFamily: 'var(--mg-font)',
  fontSize: 14,
  fontWeight: 600,
  lineHeight: 1.3,
  color: 'var(--mg-text)',
};

export interface SpecimenProps {
  /** "<Name>/<state>", for example "Button/primary". */
  name: string;
  /** The runtime exports it shows, space separated. */
  covers: string;
  /** The parity gate also compares it hovered and focused: its target carries data-kit-target. */
  hover?: boolean;
  focus?: boolean;
  /** Shown under the box, outside what the gate compares (for example why it has no core pair). */
  note?: string;
  children: ReactNode;
}

/** One specimen: its name, the box the gate compares, and a note. */
export function Specimen({ name, covers, hover, focus, note, children }: SpecimenProps) {
  return (
    <div style={WRAP}>
      <div style={LABEL}>{name}</div>
      <div
        data-kit-specimen={name}
        data-kit-covers={covers}
        data-kit-hover={hover ? '1' : undefined}
        data-kit-focus={focus ? '1' : undefined}
        style={SPECIMEN_BOX}
      >
        {children}
      </div>
      {note ? <div style={NOTE}>{note}</div> : null}
    </div>
  );
}

/** A section's group title (sheet chrome, not a specimen). */
export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div data-kit-group={title}>
      <div style={GROUP_TITLE}>{title}</div>
      {children}
    </div>
  );
}

/** One row of a formatter specimen: the call and what it gives. */
function Row({ call, out }: { call: string; out: string | number | null }) {
  return (
    <div>
      {call} → {typeof out === 'string' ? JSON.stringify(out) : String(out)}
    </div>
  );
}

const DECISIONS = [
  'Primary: #3b5bdb, matches core; proposed alternative #1570ef.',
  'Danger button: #c62828 (dialogs); danger text: #b42318.',
  'Controls: browser font, browser focus ring, no hover on primary and secondary, browser-face OFF pill, as the core today; unifying them is ROADMAP.',
  'Colour maps: rainbow, viridis, balance, curl; cividis dropped (licence).',
  "Field help tip: 260 px, without the core's 70vw cap; it looks the same as the core in any window wider than 372 px.",
];

const DECISIONS_BOX: CSSProperties = {
  display: 'block',
  width: 320,
  padding: 10,
  border: '1px solid var(--mg-warning)',
  borderRadius: 6,
  background: 'var(--mg-warning-bg)',
  fontFamily: 'var(--mg-font)',
  fontSize: 12,
  lineHeight: 1.45,
  color: 'var(--mg-text-strong)',
};

/** What Daniel signs off (gate:h14-token-sheet). */
function Decisions() {
  return (
    <div data-kit-decisions="1" style={DECISIONS_BOX}>
      <div style={{ fontWeight: 600, marginBottom: 6 }}>Decisions for sign-off</div>
      {DECISIONS.map((line) => (
        <div key={line} style={{ marginBottom: 4 }}>
          {line}
        </div>
      ))}
    </div>
  );
}

export function FoundationSection({ kit, side }: SectionProps) {
  const { Button } = kit;
  const target = { 'data-kit-target': '1' } as const;
  return (
    <>
      {side === 'page' ? <Decisions /> : null}
      <Group title="Button">
        <Specimen name="Button/primary" covers="Button" hover focus>
          <Button variant="primary" attrs={target}>
            Generate
          </Button>
        </Specimen>
        <Specimen name="Button/primary-disabled" covers="Button">
          <Button variant="primary" disabled>
            Generate
          </Button>
        </Specimen>
        <Specimen name="Button/primary-block" covers="Button" hover focus>
          <Button variant="primary" block attrs={target}>
            Start
          </Button>
        </Specimen>
        <Specimen name="Button/secondary" covers="Button" hover focus>
          <Button attrs={target}>Cancel</Button>
        </Specimen>
        <Specimen name="Button/secondary-disabled" covers="Button">
          <Button disabled>Cancel</Button>
        </Specimen>
        <Specimen name="Button/neutral" covers="Button" hover focus>
          <Button variant="neutral" attrs={target}>
            Done
          </Button>
        </Specimen>
        <Specimen name="Button/link" covers="Button" hover focus>
          <Button variant="link" attrs={target}>
            Delete
          </Button>
        </Specimen>
        <Specimen
          name="Button/fix"
          covers="Button"
          hover
          focus
          note="No core pair: the core styles this button only inside a run reason (see DisabledReason/reason-fix)."
        >
          <Button variant="fix" attrs={target}>
            Open Settings
          </Button>
        </Specimen>
        <Specimen name="Button/danger" covers="Button" hover focus note="No core pair: the core has no panel-size danger button.">
          <Button variant="danger" attrs={target}>
            Delete study
          </Button>
        </Specimen>
        <Specimen name="Button/danger-disabled" covers="Button">
          <Button variant="danger" disabled>
            Delete study
          </Button>
        </Specimen>
      </Group>
      <Group title="Formatters">
        <Specimen name="Formatters/formatSimTime" covers="formatSimTime">
          {[0, 5, 0.1, 2.5e-4, 12.345, 0.005, 0.0012, Number.NaN].map((v) => (
            <Row key={String(v)} call={`formatSimTime(${v})`} out={kit.formatSimTime(v)} />
          ))}
          <Row call="formatSimTime(0.005, { noUnit: true })" out={kit.formatSimTime(0.005, { noUnit: true })} />
        </Specimen>
        <Specimen name="Formatters/formatElapsed" covers="formatElapsed">
          {[59_000, 3_725_000, Number.NaN].map((v) => (
            <Row key={String(v)} call={`formatElapsed(${v})`} out={kit.formatElapsed(v)} />
          ))}
        </Specimen>
        <Specimen name="Formatters/formatEta" covers="formatEta">
          {[7000, 70_000, null].map((v) => (
            <Row key={String(v)} call={`formatEta(${v})`} out={kit.formatEta(v)} />
          ))}
        </Specimen>
        <Specimen name="Formatters/formatSci" covers="formatSci">
          {[0, 1.529e-5, 62.31559031, 2.5e6, null].map((v) => (
            <Row key={String(v)} call={`formatSci(${v})`} out={kit.formatSci(v)} />
          ))}
        </Specimen>
        <Specimen name="Formatters/parseSci" covers="parseSci">
          {[' 1.5e-3 ', '', 'abc'].map((t) => (
            <Row key={t} call={`parseSci(${JSON.stringify(t)})`} out={kit.parseSci(t)} />
          ))}
        </Specimen>
      </Group>
      <Group title="Constants">
        <Specimen name="Constants/PLUGIN_UI_API_VERSION" covers="PLUGIN_UI_API_VERSION">
          PLUGIN_UI_API_VERSION = {kit.PLUGIN_UI_API_VERSION}
        </Specimen>
      </Group>
    </>
  );
}
