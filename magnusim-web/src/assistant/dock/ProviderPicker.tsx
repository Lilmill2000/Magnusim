/**
 * The composer's provider picker (phase 4 spec 2.3, 6.2): before a conversation's first message
 * the person picks who answers it, from the status's `providers_ready`: the default first
 * ("<label> · default"), then the API-key providers and the local server, then the coding agents
 * ("<label> (coding agent)"). Each option's second line is the server's detail, with its billing;
 * one not ready can't be picked and says why (" · not ready"; an agent's reason in words).
 * After the first message the conversation keeps its provider: a read-only label.
 *
 * Labels and details are server data, shown as text. The listbox traps nothing: Escape closes
 * it and gives the keyboard back to its button.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { openSetupWizard } from '../../wizard/controller';
import { providerReady } from '../status';
import type { AssistantStatus, ProviderReady } from '../wire';
import { agentReason, billingTag, notReady, PROVIDER, PROVIDER_LOCKED, providerAgent, providerDefault, SET_UP_PROVIDERS } from './copy';

export interface ProviderOption {
  id: string;
  label: string;
  /** What the option reads ("<label> · default", "<label> (coding agent)"). */
  text: string;
  detail: string;
  billing: ProviderReady['billing'];
  kind: ProviderReady['kind'];
  ready: boolean;
  reason: string | null;
  isDefault: boolean;
}

/** The default provider of the status, or null when it is Off. */
export function defaultProvider(status: AssistantStatus): string | null {
  const d = status.default_provider ?? status.provider;
  return d && d !== 'off' ? d : null;
}

/** The picker's options in order: the default, then API keys and the local server, then the agents. */
export function providerOptions(status: AssistantStatus): ProviderOption[] {
  const rows = status.providers_ready && typeof status.providers_ready === 'object' ? Object.keys(status.providers_ready) : [];
  const def = defaultProvider(status);
  const ids = [...rows];
  if (def && !ids.includes(def)) ids.unshift(def);
  const out: ProviderOption[] = [];
  for (const id of ids) {
    const r = providerReady(status, id);
    if (!r) continue;
    const isDefault = id === def;
    const agentText = r.kind === 'agent' && !r.ready ? agentReason(r.reason) : null;
    const line = agentText ?? r.detail;
    out.push({
      id,
      label: r.label,
      text: isDefault ? providerDefault(r.label) : r.kind === 'agent' ? providerAgent(r.label) : r.label,
      detail: r.ready ? r.detail : notReady(line),
      billing: r.billing,
      kind: r.kind,
      ready: r.ready,
      reason: r.reason,
      isDefault,
    });
  }
  const rank = (o: ProviderOption) => (o.isDefault ? 0 : o.kind === 'agent' ? 2 : 1);
  return out.map((o, i) => ({ o, i })).sort((a, b) => rank(a.o) - rank(b.o) || a.i - b.i).map((x) => x.o);
}

const openSettings = () => openSetupWizard({ required: false, step: 'assistant' });

export function ProviderPicker({
  options,
  value,
  onPick,
  locked,
}: {
  options: readonly ProviderOption[];
  value: string | null;
  onPick: (id: string) => void;
  /** The conversation's provider label once it has a message (read-only), else null. */
  locked: string | null;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const id = useId();
  const current = options.find((o) => o.id === value) ?? null;

  useEffect(() => {
    if (!open) return;
    const i = Math.max(0, options.findIndex((o) => o.id === value));
    setActive(i);
    list.current?.focus({ preventScroll: true });
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node | null;
      if (t && (list.current?.parentElement?.contains(t) || button.current?.contains(t))) return;
      setOpen(false);
    };
    document.addEventListener('pointerdown', onDown, true);
    return () => document.removeEventListener('pointerdown', onDown, true);
    // Opening only: the options and value are read as they are then.
  }, [open]);

  if (locked !== null) {
    return (
      <span className="dock-picker-locked" title={PROVIDER_LOCKED} data-dock-provider-locked="1">
        <span className="dock-muted">{PROVIDER}:</span> {locked}
      </span>
    );
  }

  const close = () => {
    setOpen(false);
    button.current?.focus({ preventScroll: true });
  };
  const pick = (o: ProviderOption | undefined) => {
    if (!o || !o.ready) return;
    onPick(o.id);
    close();
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLUListElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (i + d + options.length) % Math.max(1, options.length));
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      pick(options[active]);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div className="dock-picker">
      <span className="dock-muted" id={`${id}-label`}>
        {PROVIDER}
      </span>
      <button
        type="button"
        ref={button}
        className="dock-picker-button"
        aria-haspopup="listbox"
        aria-expanded={open ? 'true' : 'false'}
        aria-labelledby={`${id}-label ${id}-value`}
        data-dock-provider={value ?? ''}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <span id={`${id}-value`} className="dock-picker-value">
          {current ? current.label : '—'}
        </span>
        <span aria-hidden="true"> ▾</span>
      </button>
      {open ? (
        <div className="dock-picker-pop">
          <ul
            ref={list}
            role="listbox"
            tabIndex={-1}
            aria-labelledby={`${id}-label`}
            aria-activedescendant={options[active] ? `${id}-o${active}` : undefined}
            className="dock-picker-list"
            data-dock-provider-list="1"
            onKeyDown={onKeyDown}
          >
            {options.map((o, i) => (
              <li
                key={o.id}
                id={`${id}-o${i}`}
                role="option"
                aria-selected={o.id === value ? 'true' : 'false'}
                aria-disabled={o.ready ? undefined : 'true'}
                className={`dock-picker-option${i === active ? ' active' : ''}`}
                data-dock-provider-option={o.id}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(o)}
              >
                <span className="dock-picker-option-text">{o.text}</span>
                <span className="dock-muted dock-picker-option-detail">{o.detail}</span>
                <span className="dock-muted dock-picker-option-billing">{billingTag(o.billing, o.label)}</span>
              </li>
            ))}
          </ul>
          <button type="button" className="dock-link-button" data-dock-setup-providers="1" onClick={openSettings}>
            {SET_UP_PROVIDERS}
          </button>
        </div>
      ) : null}
    </div>
  );
}
