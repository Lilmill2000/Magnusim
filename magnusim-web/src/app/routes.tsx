import { useEffect, useMemo, useState } from 'react';
import { parseHomeRoute } from '../home/controller';

export type HomeRoute = ReturnType<typeof parseHomeRoute>;

/**
 * The page's route, from the address's hash. It follows hashchange, never the address
 * at each render: the workspace leave guard puts a blocked address back with no
 * hashchange of its own.
 */
export function useHashRoute(): HomeRoute {
  const [hash, setHash] = useState(() => location.hash);
  useEffect(() => {
    const onHash = () => setHash(location.hash);
    // A hashchange that came after the first render, before this listener, still counts.
    onHash();
    window.addEventListener('hashchange', onHash);
    return () => window.removeEventListener('hashchange', onHash);
  }, []);
  return useMemo(() => parseHomeRoute(hash), [hash]);
}
