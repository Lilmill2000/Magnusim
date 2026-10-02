import { useEffect } from 'react';
import { createPortal } from 'react-dom';
import { initHome, openCreateModalFromHome } from './controller';
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
  return <HomeStartActions />;
}
