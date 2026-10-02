// Nothing ships that the dev sheet does not show: every runtime export of the
// kit is named by a specimen, and every kit-vs-core pair has exactly one kit
// twin with the same parts.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import * as kit from '../../plugin-ui';
import { Sheet } from './Sheet';
import { FoundationCore } from './sections/Foundation.core';
import { ControlsCore } from './sections/Controls.core';
import { PanelsCore } from './sections/Panels.core';
import { DataCore } from './sections/Data.core';

const CORE = [FoundationCore, ControlsCore, PanelsCore, DataCore];

function renderSheet(): HTMLElement {
  const { container } = render(
    <div>
      <Sheet kit={kit} side="page" />
      {CORE.map((Core, i) => (
        <Core key={i} />
      ))}
    </div>,
  );
  return container;
}

function attrs(root: ParentNode, selector: string, name: string): string[] {
  return [...root.querySelectorAll(selector)].map((el) => el.getAttribute(name) || '');
}

function parts(box: Element): string[] {
  return attrs(box, '[data-kit-part]', 'data-kit-part').sort();
}

describe('UI kit dev sheet coverage', () => {
  it('names every runtime export of the kit in some specimen', () => {
    const root = renderSheet();
    const covered = new Set(attrs(root, '[data-kit-covers]', 'data-kit-covers').flatMap((c) => c.split(/\s+/).filter(Boolean)));
    const exports = Object.keys(kit).sort();
    expect(exports.length).toBeGreaterThan(0);
    expect(exports.filter((name) => !covered.has(name))).toEqual([]);
  });

  it('gives each specimen one <Name>/<state> name and covers only real exports', () => {
    const root = renderSheet();
    const names = attrs(root, '[data-kit-specimen]', 'data-kit-specimen');
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name).toMatch(/^[A-Za-z]+\/[A-Za-z0-9_-]+$/);
    expect(names.filter((n, i) => names.indexOf(n) !== i)).toEqual([]);
    for (const el of root.querySelectorAll('[data-kit-specimen]')) {
      const covers = (el.getAttribute('data-kit-covers') || '').split(/\s+/).filter(Boolean);
      expect(covers.length, el.getAttribute('data-kit-specimen') || '').toBeGreaterThan(0);
      for (const name of covers) expect(Object.keys(kit), name).toContain(name);
    }
    // A hover or focus specimen says what to hover or focus.
    for (const el of root.querySelectorAll('[data-kit-hover], [data-kit-focus]')) {
      expect(el.querySelector('[data-kit-target]'), el.getAttribute('data-kit-specimen') || '').not.toBeNull();
    }
  });

  it('gives every core pair exactly one kit twin with the same parts', () => {
    const root = renderSheet();
    const pairs = attrs(root, '[data-kit-core-pair]', 'data-kit-core-pair');
    const twins = attrs(root, '[data-kit-core-kit]', 'data-kit-core-kit');
    expect(pairs.length).toBeGreaterThan(0);
    expect(pairs.filter((p, i) => pairs.indexOf(p) !== i)).toEqual([]);
    expect([...twins].sort()).toEqual([...pairs].sort());
    for (const pair of pairs) {
      const core = root.querySelector(`[data-kit-core-pair="${pair}"]`) as Element;
      const found = root.querySelectorAll(`[data-kit-core-kit="${pair}"]`);
      expect(found, pair).toHaveLength(1);
      expect(parts(core).length, pair).toBeGreaterThan(0);
      expect(parts(found[0]), pair).toEqual(parts(core));
    }
  });

  it('shows every Button state the sign-off needs, hovered and focused when enabled', () => {
    const root = renderSheet();
    const enabled = ['primary', 'primary-block', 'secondary', 'neutral', 'link', 'fix', 'danger'];
    const disabled = ['primary-disabled', 'secondary-disabled', 'danger-disabled'];
    for (const state of [...enabled, ...disabled]) {
      const box = root.querySelector(`[data-kit-specimen="Button/${state}"]`);
      expect(box, state).not.toBeNull();
      expect(box?.hasAttribute('data-kit-hover'), state).toBe(enabled.includes(state));
      expect(box?.hasAttribute('data-kit-focus'), state).toBe(enabled.includes(state));
    }
    for (const pair of ['primary', 'primary-disabled', 'secondary', 'secondary-disabled', 'neutral', 'link']) {
      expect(root.querySelector(`[data-kit-core-pair="Button/${pair}"]`), pair).not.toBeNull();
    }
  });
});
