import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { homeFolderNow, initHome, openCreateModalFromHome, openProject, refreshHome } from './controller';
import { createFromSample, sampleKey, useSamples, type SampleEntry } from './samples';
import { useHashRoute } from '../app/routes';
import { homeLabel, shownStartActions, startKey, useStartActions } from '../workspace/startActions';

/**
 * Home's start actions (API 1.4), before New project: one button per `home` action of
 * a plugin that is on (at most 3). A click opens the New Project dialog with that
 * action chosen and a title filled in, so one Create click makes the project, the
 * study and opens it.
 */
function HomeStartActions() {
  const host = typeof document !== 'undefined' ? document.getElementById('home-start-host') : null;
  const shown = shownStartActions(useStartActions()).home;
  if (!host || !shown.length) return null;
  return createPortal(
    shown.map((entry) => (
      <button
        key={startKey(entry)}
        type="button"
        className="home-btn"
        data-home-start={startKey(entry)}
        // The full text, also when the button is cut short with an ellipsis.
        title={entry.action.hint ? `${homeLabel(entry)}: ${entry.action.hint}` : `${homeLabel(entry)} (${entry.plugin_name})`}
        onClick={() => openCreateModalFromHome(undefined, { start: { plugin: entry.plugin, kind: entry.action.study_kind } })}
      >
        {homeLabel(entry)}
      </button>
    )),
    host,
  );
}

/**
 * Home's Open sample (API 1.8): a menu of the sample projects the plugins that are on
 * ship. A pick copies the sample into the projects folder as a new project (in the folder
 * Home shows) and opens it.
 * Hidden when no plugin that is on has a sample.
 */
function HomeSamples() {
  const host = typeof document !== 'undefined' ? document.getElementById('home-sample-host') : null;
  const list = useSamples();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const box = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  if (!host || !list.length) return null;
  const pick = async (entry: SampleEntry) => {
    setBusy(sampleKey(entry));
    setError('');
    let id = '';
    try {
      // Into the folder Home shows, as New project does.
      id = await createFromSample(entry, homeFolderNow() || undefined);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy('');
      return;
    }
    setOpen(false);
    setBusy('');
    void refreshHome().catch(() => undefined);
    try {
      await openProject(id);
    } catch (e) {
      // The copy is made (it is in the list); the menu is closed, so say it in a toast.
      const why = e instanceof Error ? e.message : String(e);
      window.dispatchEvent(
        new CustomEvent('cfd:toast', {
          detail: { message: `${entry.title} was copied as a new project, but it could not be opened: ${why}`, kind: 'error' },
        }),
      );
    }
  };
  return createPortal(
    <span className="home-samples" ref={box}>
      <button
        type="button"
        className="home-btn"
        data-home-samples="1"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setError('');
          setOpen(!open);
        }}
      >
        Open sample
      </button>
      {open && (
        <div className="home-samples-menu" role="menu" aria-label="Sample projects" data-home-samples-menu="1">
          {list.map((entry) => (
            <button
              key={sampleKey(entry)}
              type="button"
              role="menuitem"
              className="home-samples-item"
              data-home-sample={sampleKey(entry)}
              disabled={!!busy}
              onClick={() => void pick(entry)}
            >
              <span className="home-samples-title">{busy === sampleKey(entry) ? `Copying ${entry.title}...` : entry.title}</span>
              <span className="home-samples-hint">{entry.hint ? `${entry.hint} (${entry.plugin_name})` : entry.plugin_name}</span>
            </button>
          ))}
          {error ? (
            <p className="home-samples-error" role="alert" data-home-samples-error="1">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </span>,
    host,
  );
}

/** React home: boots the typed controller against the injected #home shell. */
export function Home() {
  const route = useHashRoute();
  useEffect(() => {
    initHome();
  }, []);
  useEffect(() => {
    document.body.classList.toggle('on-home', route.view === 'home');
    document.body.classList.toggle('on-workbench', route.view === 'workbench');
  }, [route.view]);
  return (
    <>
      <HomeSamples />
      <HomeStartActions />
    </>
  );
}
