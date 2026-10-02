/** Plugin schema-field widgets, looked up by SchemaForm through x-cfddesk.widget. */
import type { ComponentType } from 'react';

const fieldWidgets = new Map<string, ComponentType<Record<string, unknown>>>();

// Bumped on every change, so an open form picks up a widget registered after it
// mounted (plugin UIs can load after a panel is open).
let version = 0;
const subscribers = new Set<() => void>();

function changed(): void {
  version += 1;
  for (const fn of [...subscribers]) fn();
}

/** RJSF widget name for a plugin field widget (kept apart from the host widget names). */
export function pluginWidgetName(xWidget: string): string {
  return `plugin:${xWidget}`;
}

export function setFieldWidget(xWidget: string, Component: ComponentType<Record<string, unknown>>): void {
  fieldWidgets.set(xWidget, Component);
  changed();
}

export function deleteFieldWidget(xWidget: string): void {
  if (fieldWidgets.delete(xWidget)) changed();
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

/** Grows by one on each set and each delete that removed a widget. */
export function fieldWidgetsVersion(): number {
  return version;
}

/** Called after every change; returns the unsubscribe (useSyncExternalStore's shape). */
export function subscribeFieldWidgets(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}
