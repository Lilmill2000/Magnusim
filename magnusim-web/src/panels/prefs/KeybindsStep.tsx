/**
 * Settings → Keybinds: every key the person can see and set (src/keybinds/catalog.ts). The app's
 * own keys first (shown, never changed; the browser's and the system's in a fold), then each plugin
 * that is on and lists commands, by workspace and group, with the keys each command has now.
 *
 * Change waits for a key press, read as the workspace reads one (comboOf): Escape (alone) cancels,
 * Tab moves on, a key the app, the browser or the system keeps is refused with why, and a key
 * another command has where the two meet asks Replace or Cancel. Reset puts the defaults back,
 * Clear leaves no key, Reset all is the plugin's every command. Each change is stored at once and
 * an open workspace takes it live; a change made in the workspace (its Set keybind) or another tab
 * shows here as it happens.
 */
import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { isCad } from '../../app/edition';
import { APP_COMMANDS, APP_LOCAL_KEYS, RESERVED_KEYS } from '../../keybinds/appCommands';
import {
  applyChange,
  contextLabel,
  isDefault,
  KEYBINDS_PREF,
  keysOf,
  loadPluginKeys,
  refreshOverrides,
  refusalOf,
  resetAllKeys,
  SETTINGS_FROM,
  type KeyChange,
  type PluginKeys,
  type WorkspaceKeys,
} from '../../keybinds/catalog';
import { displayCombo, typedCombo } from '../../keybinds/combo';
import { comboOf, type Command } from '../../keybinds/commands';
import { onPrefChange } from '../../workspace/prefsChannel';

/** A KeyboardEvent.key of a modifier pressed alone (no combo yet). */
const MOD_KEYS = new Set(['Control', 'Shift', 'Alt', 'Meta', 'AltGraph', 'OS', 'Hyper', 'Super', 'Fn', 'CapsLock']);
/** How long a row's "Saved" stays. */
const SAVED_MS = 1800;

/** The keys of one of the app's rows, as people read them: Cmd's own forms left out (Cmd counts as Ctrl). */
function appKeysShown(keys: readonly string[]): string[] {
  return [...new Set(keys.filter((k) => !k.includes('Meta')).map(displayCombo))];
}

/** What a row waits for: a key press, or Replace / Cancel for a key another command has. */
type Editing = { plugin: string; id: string; partial: string; conflict: { change: KeyChange; message: string } | null };

function Keys({ keys }: { keys: readonly string[] }) {
  if (!keys.length) return <span className="wiz-keys-none">No key</span>;
  return (
    <>
      {keys.map((k) => (
        <kbd key={k} className="wiz-keys-kbd">
          {k}
        </kbd>
      ))}
    </>
  );
}

const matches = (query: string, ...texts: string[]) => !query || texts.some((t) => t.toLowerCase().includes(query));

export function KeybindsStep() {
  const [plugins, setPlugins] = useState<PluginKeys[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');
  const [query, setQuery] = useState('');
  const [editing, setEditing] = useState<Editing | null>(null);
  // A row's last word: "Saved", or why a press or a change was refused.
  const [notes, setNotes] = useState<Record<string, { text: string; kind: 'saved' | 'error' }>>({});
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const captureRef = useRef<HTMLSpanElement | null>(null);
  const pluginsRef = useRef(plugins);
  pluginsRef.current = plugins;

  const put = (next: PluginKeys) => setPlugins((list) => list.map((p) => (p.plugin === next.plugin ? next : p)));
  const note = (rowKey: string, text: string, kind: 'saved' | 'error') => {
    setNotes((n) => ({ ...n, [rowKey]: { text, kind } }));
    const was = timers.current.get(rowKey);
    if (was) clearTimeout(was);
    timers.current.delete(rowKey);
    if (kind === 'saved') {
      timers.current.set(
        rowKey,
        setTimeout(() => {
          timers.current.delete(rowKey);
          setNotes((n) => {
            const { [rowKey]: _gone, ...rest } = n;
            return rest;
          });
        }, SAVED_MS),
      );
    }
  };

  useEffect(() => {
    let live = true;
    void loadPluginKeys().then(({ plugins: list, error: why }) => {
      if (!live) return;
      setPlugins(list);
      setError(why);
      setLoaded(true);
    });
    // A change made in a workspace (its Set keybind) or in another tab's Settings shows here.
    const stop = onPrefChange((c) => {
      if (c.key !== KEYBINDS_PREF || c.from === SETTINGS_FROM) return;
      const p = pluginsRef.current.find((x) => x.plugin === c.plugin);
      if (p) void refreshOverrides(p).then((next) => live && put(next));
    });
    const own = timers.current;
    return () => {
      live = false;
      stop();
      for (const t of own.values()) clearTimeout(t);
    };
  }, []);

  useEffect(() => {
    if (editing && !editing.conflict) captureRef.current?.focus({ preventScroll: true });
  }, [editing]);

  const rowKey = (plugin: string, id: string) => `${plugin}\u0000${id}`;

  async function change(p: PluginKeys, id: string, c: KeyChange) {
    const key = rowKey(p.plugin, id);
    const { result, plugin } = await applyChange(p, id, c, displayCombo);
    put(plugin);
    if (result.ok) {
      setEditing((e) => (e && e.plugin === p.plugin && e.id === id ? null : e));
      const took = result.took.map((t) => t.label);
      note(key, took.length ? `Saved. Taken from ${took.join(', ')}.` : 'Saved', 'saved');
      return;
    }
    if (result.code === 'conflict') {
      setEditing({ plugin: p.plugin, id, partial: '', conflict: { change: { ...c, replace: true } as KeyChange, message: result.message } });
      return;
    }
    setEditing(null);
    note(key, result.message, 'error');
  }

  function onCaptureKey(e: ReactKeyboardEvent<HTMLSpanElement>, p: PluginKeys, command: Command) {
    const ev = e.nativeEvent;
    if (ev.isComposing) return;
    const mods = e.ctrlKey || e.altKey || e.metaKey;
    // Tab moves on (the recorder lets go as it loses focus).
    if (e.key === 'Tab' && !mods) return;
    e.preventDefault();
    e.stopPropagation();
    const key = rowKey(p.plugin, command.id);
    if (e.key === 'Escape' && !mods && !e.shiftKey) {
      setEditing(null);
      return;
    }
    if (MOD_KEYS.has(e.key)) {
      const held = [(e.ctrlKey || e.metaKey) && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift'].filter(Boolean).join('+');
      setEditing((x) => (x ? { ...x, partial: held } : x));
      return;
    }
    const combo = comboOf(ev);
    if (!combo) {
      note(key, `${e.key || e.code} can't be a shortcut key. Press another.`, 'error');
      return;
    }
    const typed = typedCombo(ev, combo);
    const why = refusalOf(combo, displayCombo) || (typed ? refusalOf(typed, displayCombo) : '');
    if (why) {
      note(key, `${why}. Press another.`, 'error');
      setEditing((x) => (x ? { ...x, partial: '' } : x));
      return;
    }
    void change(p, command.id, { action: 'set', combo });
  }

  const q = query.trim().toLowerCase();
  const appName = isCad() ? 'Magnusim CAD' : 'Magnusim';
  const appRows = useMemo(() => [...APP_COMMANDS, ...APP_LOCAL_KEYS].filter((c) => matches(q, c.label, c.group, ...appKeysShown(c.keys))), [q]);
  const reservedRows = useMemo(() => RESERVED_KEYS.filter((c) => matches(q, c.label, ...c.keys.map(displayCombo))), [q]);

  function commandRow(p: PluginKeys, ws: WorkspaceKeys, c: Command) {
    const key = rowKey(p.plugin, c.id);
    const keys = keysOf(p, c.id).map(displayCombo);
    const mine = editing && editing.plugin === p.plugin && editing.id === c.id ? editing : null;
    const said = notes[key];
    return (
      <li key={c.id} className="wiz-keys-row" data-keybind={c.id} data-keybind-default={isDefault(p, c.id) ? '1' : '0'}>
        <span className="wiz-keys-label">
          {c.label}
          <span className="wiz-keys-where">{contextLabel(ws, c.context)}</span>
        </span>
        <span className="wiz-keys-keys" data-keybind-keys>
          {mine && !mine.conflict ? (
            <span
              ref={captureRef}
              className="wiz-keys-capture"
              role="textbox"
              tabIndex={0}
              aria-label={`Press the new keys for ${c.label}`}
              data-keybind-capture
              onKeyDown={(e) => onCaptureKey(e, p, c)}
              onBlur={() => setEditing((x) => (x === mine ? null : x))}
            >
              {mine.partial ? `${mine.partial}+…` : 'Press the new keys…'}
            </span>
          ) : (
            <Keys keys={keys} />
          )}
        </span>
        <span className="wiz-keys-actions">
          {mine && !mine.conflict ? (
            <button type="button" className="wiz-reset" onMouseDown={(e) => e.preventDefault()} onClick={() => setEditing(null)}>
              Cancel
            </button>
          ) : (
            <>
              <button type="button" className="wiz-reset" data-keybind-change disabled={!!p.unread} onClick={() => setEditing({ plugin: p.plugin, id: c.id, partial: '', conflict: null })}>
                Change
              </button>
              {!isDefault(p, c.id) ? (
                <button type="button" className="wiz-reset" data-keybind-reset disabled={!!p.unread} onClick={() => void change(p, c.id, { action: 'reset' })}>
                  Reset
                </button>
              ) : null}
              {keys.length ? (
                <button type="button" className="wiz-reset" data-keybind-clear disabled={!!p.unread} onClick={() => void change(p, c.id, { action: 'clear' })}>
                  Clear
                </button>
              ) : null}
            </>
          )}
        </span>
        {mine && mine.conflict ? (
          <span className="wiz-keys-conflict" role="alert" data-keybind-conflict>
            <span>{mine.conflict.message}.</span>
            <button type="button" className="wiz-reset" data-keybind-replace onClick={() => void change(p, c.id, mine.conflict!.change)}>
              Replace
            </button>
            <button type="button" className="wiz-reset" onClick={() => setEditing(null)}>
              Cancel
            </button>
          </span>
        ) : said ? (
          <span className={said.kind === 'saved' ? 'wiz-keys-saved' : 'wiz-keys-error'} role={said.kind === 'saved' ? 'status' : 'alert'} data-keybind-note={said.kind}>
            {said.text}
          </span>
        ) : null}
      </li>
    );
  }

  function workspaceBlock(p: PluginKeys, ws: WorkspaceKeys) {
    const shown = ws.commands.filter((c) => matches(q, c.label, c.group, contextLabel(ws, c.context), p.name, ws.title, ...keysOf(p, c.id).map(displayCombo)));
    if (q && !shown.length && !ws.error) return null;
    const groups = [...new Set(shown.map((c) => c.group))];
    return (
      <div key={ws.workspace} className="wiz-keys-ws" data-keys-workspace={ws.workspace}>
        <h5 className="wiz-keys-ws-title">{ws.title} workspace</h5>
        {ws.error ? (
          <p className="wiz-keys-error" role="alert" data-keys-workspace-error>
            Its keys can't be listed: {ws.error}
          </p>
        ) : null}
        {groups.map((g) => (
          <div key={g || '-'} className="wiz-keys-group">
            {g ? <h6 className="wiz-keys-group-title">{g}</h6> : null}
            <ul className="wiz-keys-list">{shown.filter((c) => c.group === g).map((c) => commandRow(p, ws, c))}</ul>
          </div>
        ))}
      </div>
    );
  }

  const pluginBlocks = plugins.map((p) => {
    const blocks = p.workspaces.map((ws) => workspaceBlock(p, ws)).filter(Boolean);
    if (q && !blocks.length) return null;
    const changed = Object.keys(p.overrides).some((id) => !isDefault(p, id));
    return (
      <section key={p.plugin} className="wiz-keys-scope" data-keys-plugin={p.plugin}>
        <div className="wiz-keys-scope-head">
          <h4 className="wiz-keys-scope-title">{p.name}</h4>
          <button
            type="button"
            className="wiz-reset"
            data-keys-reset-all
            disabled={!changed || !!p.unread}
            onClick={async () => {
              const r = await resetAllKeys(p);
              if (r.ok) {
                put(r.plugin);
                note(rowKey(p.plugin, ''), 'Every command has its default keys again.', 'saved');
              } else note(rowKey(p.plugin, ''), r.message, 'error');
            }}
          >
            Reset all
          </button>
        </div>
        {p.unread ? (
          <p className="wiz-keys-error" role="alert" data-keys-unread>
            {p.unread}. Changes wait until they can be read.{' '}
            <button type="button" className="wiz-reset" onClick={() => void refreshOverrides(p).then(put)}>
              Try again
            </button>
          </p>
        ) : null}
        {notes[rowKey(p.plugin, '')] ? (
          <p className={notes[rowKey(p.plugin, '')].kind === 'saved' ? 'wiz-keys-saved' : 'wiz-keys-error'} role="status">
            {notes[rowKey(p.plugin, '')].text}
          </p>
        ) : null}
        {blocks}
      </section>
    );
  });

  return (
    <div className="wiz-keys" data-keybinds>
      <input
        type="search"
        className="wiz-keys-search"
        placeholder="Search keybinds"
        aria-label="Search keybinds"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        data-keys-search
      />
      {error ? (
        <p className="wiz-keys-error" role="alert">
          {error}
        </p>
      ) : null}
      {appRows.length || reservedRows.length ? (
        <section className="wiz-keys-scope" data-keys-plugin="app">
          <div className="wiz-keys-scope-head">
            <h4 className="wiz-keys-scope-title">{appName}</h4>
          </div>
          <p className="wiz-keys-copy">The app's own keys work everywhere and can't be changed.</p>
          {appRows.length ? (
            <ul className="wiz-keys-list">
              {appRows.map((c) => (
                <li key={c.id} className="wiz-keys-row" data-keybind={c.id}>
                  <span className="wiz-keys-label">{c.label}</span>
                  <span className="wiz-keys-keys" data-keybind-keys>
                    <Keys keys={appKeysShown(c.keys)} />
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
          {reservedRows.length ? (
            <details className="wiz-keys-reserved" open={!!q} data-keys-reserved>
              <summary>Kept for the browser and the system</summary>
              <ul className="wiz-keys-list">
                {reservedRows.map((c) => (
                  <li key={c.id} className="wiz-keys-row" data-keybind={c.id}>
                    <span className="wiz-keys-label">{c.label}</span>
                    <span className="wiz-keys-keys" data-keybind-keys>
                      <Keys keys={c.keys.map(displayCombo)} />
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </section>
      ) : null}
      {loaded && !plugins.length && !error ? <p className="wiz-keys-copy">No plugin that is on has keys of its own.</p> : null}
      {pluginBlocks}
      {loaded && q && !appRows.length && !reservedRows.length && !pluginBlocks.some(Boolean) ? (
        <p className="wiz-keys-copy" data-keys-none>
          No keybind matches “{query.trim()}”.
        </p>
      ) : null}
    </div>
  );
}
