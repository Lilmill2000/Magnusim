/**
 * The dev sheet's Panels section: PanelChrome, StatusBlock, Elapsed, Toast and
 * PanelError, drawn through the kit it is given (the page's copy or the frame's).
 * Nothing here is live: page and frame draw at different moments.
 */
import { useLayoutEffect } from 'react';
import { Group, Specimen, type Kit, type SectionProps } from './Foundation';

const noop = () => undefined;

// A run that took 1:02:05, finished: Elapsed shows the same in page and frame.
const STARTED = 1_000_000;
const FINISHED = STARTED + 3_725_000;

/**
 * Marks the element a kit prop cannot reach (the Done inside PanelChrome, a
 * toast's ×) as the specimen's hover and focus target. Renders nothing.
 */
function Target({ specimen, selector }: { specimen: string; selector: string }) {
  useLayoutEffect(() => {
    document.querySelector(`[data-kit-specimen="${specimen}"] ${selector}`)?.setAttribute('data-kit-target', '1');
  });
  return null;
}

/** useElapsed itself, frozen. */
function ElapsedHook({ kit }: { kit: Kit }) {
  const text = kit.useElapsed(STARTED, FINISHED);
  return <>useElapsed(start, start + 3725000) → {JSON.stringify(text)}</>;
}

export function PanelsSection({ kit }: SectionProps) {
  const { Button, PanelChrome, StatusBlock, Elapsed, Toast, PanelError } = kit;
  const chrome = (name: string, extra: { onDelete?: () => void; card?: boolean; footExtra?: boolean }) => (
    <Specimen name={`PanelChrome/${name}`} covers="PanelChrome" hover focus>
      <PanelChrome
        title="Boundary layer"
        onDone={noop}
        onDelete={extra.onDelete}
        card={extra.card}
        footExtra={
          extra.footExtra ? (
            <Button variant="link" onClick={noop}>
              Duplicate
            </Button>
          ) : undefined
        }
      >
        First layer 0.1 mm, growth 1.2, 5 layers.
      </PanelChrome>
      <Target specimen={`PanelChrome/${name}`} selector=".mgk-panel-done" />
    </Specimen>
  );
  const toast = (kind: 'info' | 'success' | 'error', message: string) => (
    <Specimen name={`Toast/${kind}`} covers="Toast" focus>
      <Toast message={message} kind={kind} durationMs={0} onClose={noop} />
      <Target specimen={`Toast/${kind}`} selector=".mgk-toast-close" />
    </Specimen>
  );
  return (
    <>
      <Group title="PanelChrome">
        {chrome('plain', {})}
        {chrome('delete', { onDelete: noop })}
        {chrome('card', { onDelete: noop, card: true })}
        {chrome('foot-extra', { onDelete: noop, footExtra: true })}
      </Group>
      <Group title="StatusBlock">
        <Specimen name="StatusBlock/running" covers="StatusBlock">
          <StatusBlock title="Generating mesh" status="running" line="Snapping to the surface…" elapsed="0:42" />
        </Specimen>
        <Specimen name="StatusBlock/done" covers="StatusBlock">
          <StatusBlock title="Mesh ready" status="done" line="48,213 cells / 52,907 nodes" meta={['Standard', '3 layers', '0:42']} />
        </Specimen>
        <Specimen name="StatusBlock/eta" covers="StatusBlock">
          <StatusBlock title="Running" status="running" line="Iteration 120 of 500" elapsed="0:42" eta={kit.formatEta(70_000)} />
        </Specimen>
        <Specimen name="Elapsed/fixed" covers="Elapsed" note="No core pair: the core draws the elapsed time inside its status block.">
          <Elapsed startedAt={STARTED} finishedAt={FINISHED} />
        </Specimen>
        <Specimen name="Elapsed/hook" covers="useElapsed">
          <ElapsedHook kit={kit} />
        </Specimen>
      </Group>
      <Group title="Toast">
        {toast('info', 'Saved the polar.')}
        {toast('success', 'Kit toast')}
        {toast('error', 'Could not save: the study changed in another tab.')}
      </Group>
      <Group title="PanelError">
        <Specimen
          name="PanelError/card"
          covers="PanelError"
          note="No core pair: a new look (the core showed the bare error text)."
        >
          <PanelError message="Cannot read properties of undefined (reading 'mesh')" onRetry={noop} />
        </Specimen>
        <Specimen name="PanelError/with-done" covers="PanelError">
          <PanelError message="panel failed" onRetry={noop} onDone={noop} />
        </Specimen>
      </Group>
    </>
  );
}
