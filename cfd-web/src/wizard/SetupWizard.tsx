import { useEffect } from 'react';
import { initSetupWizard, openSetupWizard } from './controller';

export function SetupWizard() {
  useEffect(() => {
    window.__CFD_OPEN_WIZARD__ = (opts) => openSetupWizard(opts);
    void initSetupWizard();
    return () => {
      delete window.__CFD_OPEN_WIZARD__;
    };
  }, []);
  return null;
}
