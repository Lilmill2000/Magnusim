import { useEffect } from 'react';
import { initHome } from './controller';
import { useHashRoute } from '../app/routes';

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
  return null;
}
