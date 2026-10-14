// A plugin UI entry whose register() throws, for PluginsStep.lateErrors.test.tsx (the
// loader records it as a client error: a "Failed to load" row in Settings → Plugins).
export function register(): void {
  throw new Error('example-laminar UI: register() failed');
}
