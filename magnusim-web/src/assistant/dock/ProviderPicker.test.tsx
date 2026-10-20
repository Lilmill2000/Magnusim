// The composer's provider picker (phase 4 spec 2.3): order, details, billing, not ready, locked.
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantStatus } from '../wire';
import { ProviderPicker, providerOptions } from './ProviderPicker';

const wizard = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('../../wizard/controller', () => ({ openSetupWizard: wizard.open }));

const row = (label: string, kind: string, ready: boolean, billing: string, detail: string, reason: string | null = null) => ({ label, kind, ready, billing, detail, reason });
const STATUS = {
  provider: 'openai_compatible',
  default_provider: 'openai_compatible',
  providers_ready: {
    'agent:helper': row('Helper', 'agent', true, 'agent_account', 'Signed in · 0.85.1'),
    first_cloud: row('Cloud A', 'key', true, 'usd', 'Key set, ends in …a1b2 · big'),
    second_cloud: row('Cloud B', 'key', false, 'usd', 'No key', 'no_key'),
    openai_compatible: row('Local server', 'server', true, 'free', 'qwen'),
    'agent:off': row('Other', 'agent', false, 'agent_account', '', 'agent_not_allowed'),
    'agent:gone': row('Gone', 'agent', false, 'agent_account', 'x', 'agent_missing'),
    'agent:changed': row('Changed', 'agent', false, 'agent_account', 'x', 'agent_allow_changed'),
    'agent:out': row('Out', 'agent', false, 'agent_account', 'x', 'agent_signed_out'),
    'agent:mcp': row('Mcp', 'agent', false, 'agent_account', 'x', 'mcp_unavailable'),
    'agent:new': row('New', 'agent', false, 'agent_account', 'x', 'not_checked'),
  },
} as unknown as AssistantStatus;

describe('providerOptions', () => {
  it('the default first, then the API keys and the local server, then the coding agents; each with its line', () => {
    const o = providerOptions(STATUS);
    expect(o.map((x) => x.text)).toEqual([
      'Local server · default',
      'Cloud A',
      'Cloud B',
      'Helper (coding agent)',
      'Other (coding agent)',
      'Gone (coding agent)',
      'Changed (coding agent)',
      'Out (coding agent)',
      'Mcp (coding agent)',
      'New (coding agent)',
    ]);
    expect(o.map((x) => x.detail)).toEqual([
      'qwen',
      'Key set, ends in …a1b2 · big',
      'No key · not ready',
      'Signed in · 0.85.1',
      'Off until you allow it in Settings → Assistant · not ready',
      'Not installed · not ready',
      'Its command changed: allow it again · not ready',
      'Not signed in · not ready',
      "Its tool connection isn't running · not ready",
      'Not looked for yet: open Settings → Assistant · not ready',
    ]);
  });
});

describe('the picker', () => {
  it('a listbox: billing tags, not-ready options disabled and not picked; Escape gives the keyboard back', () => {
    const onPick = vi.fn();
    render(<ProviderPicker options={providerOptions(STATUS)} value="openai_compatible" onPick={onPick} locked={null} />);
    const button = screen.getByRole('button', { name: /Provider/ });
    fireEvent.click(button);
    const list = screen.getByRole('listbox');
    expect(document.activeElement).toBe(list);
    const opt = (id: string) => document.querySelector(`[data-dock-provider-option="${id}"]`) as HTMLElement;
    expect(opt('openai_compatible').getAttribute('aria-selected')).toBe('true');
    expect(opt('first_cloud').querySelector('.dock-picker-option-billing')?.textContent).toBe('API key, $ limits apply');
    expect(opt('openai_compatible').querySelector('.dock-picker-option-billing')?.textContent).toBe('No cost');
    expect(opt('agent:helper').querySelector('.dock-picker-option-billing')?.textContent).toBe('Billed to your Helper account');
    expect(opt('second_cloud').getAttribute('aria-disabled')).toBe('true');
    fireEvent.click(opt('second_cloud'));
    expect(onPick).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: 'ArrowDown' });
    fireEvent.keyDown(list, { key: 'Enter' });
    expect(onPick).toHaveBeenCalledWith('first_cloud');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    fireEvent.click(screen.getByText('Set up providers in Settings → Assistant'));
    expect(wizard.open).toHaveBeenCalledWith({ required: false, step: 'assistant' });
    fireEvent.keyDown(screen.getByRole('listbox'), { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(document.activeElement).toBe(button);
  });

  it('locked after the first message: the provider as text, saying why', () => {
    render(<ProviderPicker options={providerOptions(STATUS)} value="first_cloud" onPick={() => undefined} locked="Cloud A" />);
    const el = document.querySelector('[data-dock-provider-locked]') as HTMLElement;
    expect(el.textContent).toBe('Provider: Cloud A');
    expect(el.title).toBe('A conversation keeps its provider. Start a new one to use another.');
    expect(screen.queryByRole('button')).toBeNull();
  });
});
