// The bridge's projectLinks (src/lib/bridge.ts): Magnusim CAD's welcome says
// ws.context.projectLinks false (no projects, no simulation); absent, as on Magnusim and older
// hosts, it is true. Only an explicit false turns it off.
// SPDX-License-Identifier: GPL-3.0-or-later
import { describe, expect, it } from 'vitest';
import { createBridge } from '../../src/lib/bridge';
import { createFakeWorkspace } from '../fakes/workspace-sdk';

describe('Bridge projectLinks', () => {
  it('is true with no flag (Magnusim, older hosts) and false only when the welcome says false', () => {
    expect(createBridge(createFakeWorkspace()).projectLinks()).toBe(true);
    expect('projectLinks' in createFakeWorkspace().context).toBe(false);
    expect(createBridge(createFakeWorkspace({ projectLinks: true })).projectLinks()).toBe(true);
    expect(createBridge(createFakeWorkspace({ projectLinks: false })).projectLinks()).toBe(false);
    // Anything but false is a host with projects.
    const odd = createFakeWorkspace();
    (odd.context as unknown as Record<string, unknown>).projectLinks = 'no';
    expect(createBridge(odd).projectLinks()).toBe(true);
  });
});
