import { useEffect } from 'react';
import { screenshotFrame } from '../viewer/capture';

export function TopToolbar() {
  useEffect(() => {
    const onClick = (e: Event) => {
      const btn = (e.target as HTMLElement).closest('#toolbar [data-label="Screenshot"]');
      if (!btn) return;
      const canvas = document.querySelector('#viewer canvas') as HTMLCanvasElement | null;
      void screenshotFrame(canvas);
    };
    document.addEventListener('click', onClick);
    return () => document.removeEventListener('click', onClick);
  }, []);
  return null;
}
