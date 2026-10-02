import { describe, expect, it, vi } from 'vitest';
import {
  deleteFieldWidget,
  fieldWidgetsVersion,
  hasFieldWidget,
  pluginFieldWidgets,
  setFieldWidget,
  subscribeFieldWidgets,
} from './fieldWidgets';

const Blank = () => null;
const Other = () => null;

describe('plugin field widget store', () => {
  it('bumps its version on set and on a delete that removes a widget', () => {
    const v0 = fieldWidgetsVersion();
    setFieldWidget('fw-test.a', Blank);
    expect(fieldWidgetsVersion()).toBe(v0 + 1);
    setFieldWidget('fw-test.a', Other);
    expect(fieldWidgetsVersion()).toBe(v0 + 2);
    expect(pluginFieldWidgets()['plugin:fw-test.a']).toBe(Other);
    deleteFieldWidget('fw-test.a');
    expect(fieldWidgetsVersion()).toBe(v0 + 3);
    expect(hasFieldWidget('fw-test.a')).toBe(false);
    // Nothing to remove: nothing changed.
    deleteFieldWidget('fw-test.a');
    expect(fieldWidgetsVersion()).toBe(v0 + 3);
  });

  it('calls subscribers on each change, until they unsubscribe', () => {
    const fn = vi.fn();
    const off = subscribeFieldWidgets(fn);
    try {
      setFieldWidget('fw-test.b', Blank);
      expect(fn).toHaveBeenCalledTimes(1);
      deleteFieldWidget('fw-test.b');
      expect(fn).toHaveBeenCalledTimes(2);
    } finally {
      off();
    }
    setFieldWidget('fw-test.b', Blank);
    deleteFieldWidget('fw-test.b');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('a subscriber sees the new version when it is called', () => {
    const seen: number[] = [];
    const off = subscribeFieldWidgets(() => seen.push(fieldWidgetsVersion()));
    try {
      setFieldWidget('fw-test.c', Blank);
      deleteFieldWidget('fw-test.c');
    } finally {
      off();
    }
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0] + 1);
    expect(seen[1]).toBe(fieldWidgetsVersion());
  });
});
