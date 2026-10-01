// React access to the app's services. Frozen (scaffold).
// SPDX-License-Identifier: GPL-3.0-or-later
import { createContext, useContext, type ReactNode } from 'react';
import type { AppServices } from '../types/app';

const ServicesContext = createContext<AppServices | null>(null);

export function ServicesProvider({ services, children }: { services: AppServices; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): AppServices {
  const s = useContext(ServicesContext);
  if (!s) throw new Error('useServices() outside <ServicesProvider>');
  return s;
}
