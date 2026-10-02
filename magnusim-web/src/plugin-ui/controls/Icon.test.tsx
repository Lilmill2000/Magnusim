import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { Icon, type IconName } from './Icon';

// The core's own paths (RenameTitle.tsx, LeftTree.tsx, WorkspaceOverlay.tsx).
const CORE: Record<IconName, string[]> = {
  pencil: ['M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z', 'M13.8 6.9l3.2 3.2'],
  trash: ['M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13'],
  back: ['M15 5l-7 7 7 7'],
  document: ['M5 4h10l4 4v12H5z M15 4v4h4'],
};

function svgOf(container: HTMLElement): SVGSVGElement {
  return container.querySelector('svg') as SVGSVGElement;
}

describe('Icon', () => {
  it('draws each named icon with the core path', () => {
    for (const [name, paths] of Object.entries(CORE) as Array<[IconName, string[]]>) {
      const { container, unmount } = render(<Icon name={name} />);
      const svg = svgOf(container);
      expect(svg.getAttribute('class')).toBe('mgk-icon');
      expect(svg.getAttribute('viewBox')).toBe('0 0 24 24');
      expect([...svg.querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual(paths);
      unmount();
    }
  });

  it('draws a given path', () => {
    const { container } = render(<Icon path="M4 12h16" />);
    expect([...svgOf(container).querySelectorAll('path')].map((p) => p.getAttribute('d'))).toEqual(['M4 12h16']);
  });

  it('takes exactly one of name or path', () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() => render(<Icon />)).toThrow(/exactly one/);
      expect(() => render(<Icon name="trash" path="M0 0h1" />)).toThrow(/exactly one/);
      expect(() => render(<Icon name={'nope' as IconName} />)).toThrow(/no icon named nope/);
    } finally {
      errors.mockRestore();
    }
  });

  it('is hidden from screen readers unless it has a title', () => {
    const { container, rerender } = render(<Icon name="back" />);
    expect(svgOf(container).getAttribute('aria-hidden')).toBe('true');
    expect(svgOf(container).getAttribute('focusable')).toBe('false');
    expect(svgOf(container).querySelector('title')).toBeNull();
    rerender(<Icon name="back" title="Back to project" />);
    expect(svgOf(container).hasAttribute('aria-hidden')).toBe(false);
    expect(svgOf(container).querySelector('title')).toHaveTextContent('Back to project');
  });

  it('size and stroke: 15 and 1.8 by default, as the core', () => {
    const { container, rerender } = render(<Icon name="pencil" />);
    const g = () => svgOf(container).querySelector('g') as SVGGElement;
    expect(svgOf(container).getAttribute('width')).toBe('15');
    expect(svgOf(container).getAttribute('height')).toBe('15');
    expect(g().getAttribute('stroke-width')).toBe('1.8');
    expect(g().getAttribute('fill')).toBe('none');
    expect(g().getAttribute('stroke')).toBe('currentColor');
    expect(g().getAttribute('stroke-linecap')).toBe('round');
    expect(g().getAttribute('stroke-linejoin')).toBe('round');
    rerender(<Icon name="pencil" size={13} stroke={1.7} />);
    expect(svgOf(container).getAttribute('width')).toBe('13');
    expect(svgOf(container).getAttribute('height')).toBe('13');
    expect(g().getAttribute('stroke-width')).toBe('1.7');
  });
});
