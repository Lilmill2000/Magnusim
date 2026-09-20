import { useEffect, useState } from 'react';
import { parseHomeRoute } from '../home/controller';

export type HomeRoute = ReturnType<typeof parseHomeRoute>;

export function useHashRoute(): HomeRoute {
  const [route, setRoute] = useState<HomeRoute>(() => parseHomeRoute());
  useEffect(() => {
    const onHash = () => setRoute(parseHomeRoute());
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return route;
}
