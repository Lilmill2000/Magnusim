import React from 'react';
import { describe, expect, it } from 'vitest';
import * as kit from '../plugin-ui';
import { loadOnePlugin } from './loader';

type HostGlobals = { __MAGNUSIM_HOST_KIT__?: unknown; __MAGNUSIM_HOST_REACT__?: unknown };

describe('loadOnePlugin', () => {
  it("gives a plugin UI the page's React and kit before it loads (a bundled UI's react and @magnusim/plugin-ui shims read them)", async () => {
    const g = globalThis as HostGlobals;
    delete g.__MAGNUSIM_HOST_KIT__;
    delete g.__MAGNUSIM_HOST_REACT__;
    // No such file here: the import fails, after the globals are set.
    await loadOnePlugin({ key: 'kit-probe', ui: 'index.js', status: 'enabled', url: '/plugins/kit-probe/ui/missing.js' }, '').catch(() => undefined);
    expect(g.__MAGNUSIM_HOST_KIT__).toBe(kit);
    expect(g.__MAGNUSIM_HOST_REACT__).toBe(React);
  });
});
