// The model's words in the dock (phase 4 spec 2.5): a safe subset, never HTML, never a link.
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ModelText, parseBlocks } from './ModelText';

const html = (text: string, streaming = false) => {
  const { container } = render(<ModelText text={text} streaming={streaming} />);
  return container.firstElementChild as HTMLElement;
};

describe('ModelText', () => {
  it('renders paragraphs, lists, fenced code, inline code and bold', () => {
    const el = html('First line\nsecond line\n\n- one\n- **two**\n\n1. a\n2. b `x`\n\n```\nlet a = 1;\n\nlet b = 2;\n```\nAfter');
    const ps = el.querySelectorAll('p');
    expect(ps[0].innerHTML).toBe('First line<br>second line');
    expect([...el.querySelectorAll('ul li')].map((li) => li.innerHTML)).toEqual(['one', '<strong>two</strong>']);
    expect(el.querySelector('ol')?.getAttribute('start')).toBe('1');
    expect([...el.querySelectorAll('ol li')].map((li) => li.innerHTML)).toEqual(['a', 'b <code>x</code>']);
    expect(el.querySelector('pre code')?.textContent).toBe('let a = 1;\n\nlet b = 2;');
    expect(ps[ps.length - 1].textContent).toBe('After');
  });

  it('keeps <script>, HTML and javascript: as text, and never makes a link', () => {
    const evil = '<script>alert(1)</script> <img src=x onerror=alert(2)> [click](javascript:alert(3)) https://example.com <a href="x">a</a>';
    const el = html(evil);
    expect(el.querySelector('script, img, a, iframe')).toBeNull();
    expect(el.textContent).toBe(evil);
    // Inside code and bold too.
    const el2 = html('`<b>x</b>` **<i>y</i>**');
    expect(el2.querySelector('b, i')).toBeNull();
    expect(el2.querySelector('code')?.textContent).toBe('<b>x</b>');
    expect(el2.querySelector('strong')?.textContent).toBe('<i>y</i>');
  });

  it('says it streams: aria-busy and a caret', () => {
    const el = html('Working on it', true);
    expect(el.getAttribute('aria-busy')).toBe('true');
    expect(el.querySelector('.dock-caret')?.textContent).toBe('▍');
    const done = html('Done');
    expect(done.getAttribute('aria-busy')).toBeNull();
    expect(done.querySelector('.dock-caret')).toBeNull();
  });

  it('an unclosed fence (still streaming) runs to the end', () => {
    expect(parseBlocks('Look:\n```\ncode so far')).toEqual([
      { kind: 'p', lines: ['Look:'] },
      { kind: 'code', text: 'code so far' },
    ]);
  });
});
