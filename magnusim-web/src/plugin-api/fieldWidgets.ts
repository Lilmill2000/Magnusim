/** Plugin schema-field widgets, looked up by SchemaForm through x-cfddesk.widget. */
import type { ComponentType } from 'react';

const fieldWidgets = new Map<string, ComponentType<Record<string, unknown>>>();

/** RJSF widget name for a plugin field widget (kept apart from the host widget names). */
export function pluginWidgetName(xWidget: string): string {
  return `plugin:${xWidget}`;
}

export function setFieldWidget(xWidget: string, Component: ComponentType<Record<string, unknown>>): void {
  fieldWidgets.set(xWidget, Component);
}

export function deleteFieldWidget(xWidget: string): void {
  fieldWidgets.delete(xWidget);
}

export function hasFieldWidget(xWidget: string): boolean {
  return fieldWidgets.has(xWidget);
}

/** RJSF widgets map entries for every registered plugin field widget. */
export function pluginFieldWidgets(): Record<string, ComponentType<Record<string, unknown>>> {
  const out: Record<string, ComponentType<Record<string, unknown>>> = {};
  for (const [name, Component] of fieldWidgets) out[pluginWidgetName(name)] = Component;
  return out;
}
