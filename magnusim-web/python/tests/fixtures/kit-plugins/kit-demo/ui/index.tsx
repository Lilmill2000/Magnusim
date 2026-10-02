/**
 * The kit demo's field widget (gate:h14-field-widget-kit): the mesher's
 * fineness drawn with the kit's NumberUnitInput. `react` and
 * `@magnusim/plugin-ui` resolve to the page's own copies through the host's
 * shims; useTransition proves the React shim exports every name.
 */
import { useTransition } from 'react';
import { NumberUnitInput, type FieldWidgetProps } from '@magnusim/plugin-ui';
import type { PluginHost } from '../../../../../../src/plugins/loader';

/** Only the control: the schema form draws the row and the label. */
function Rate(p: FieldWidgetProps) {
  const [, startTransition] = useTransition();
  return (
    <NumberUnitInput
      label={p.label}
      id={p.id}
      width="fill"
      valueSi={typeof p.value === 'number' ? p.value : null}
      onCommitSi={(v) => startTransition(() => p.onChange(Math.round(v)))}
    />
  );
}

export function register(host: PluginHost): void {
  host.pluginUi.registerFieldWidget('kit-demo.number', Rate);
}
