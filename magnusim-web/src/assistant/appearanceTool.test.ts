import { describe, expect, it } from 'vitest';
import type { Appearance } from '../theme/appearance';
import { coreAppearance, coreSetAppearance, LOOK_SET_IN, type LookRuntime } from './appearanceTool';

/** The page's look, and what the tool asked it to save. */
function runtime(start: Appearance = { theme: 'light', text_scale: 1, icon_scale: 1 }, refuse = '') {
  let now = { ...start };
  const saves: Partial<Appearance>[] = [];
  const rt: LookRuntime = {
    current: () => ({ ...now }),
    save: async (patch) => {
      saves.push(patch);
      if (refuse) return { ok: false, error: refuse };
      now = { ...now, ...patch };
      return { ok: true, appearance: { ...now } };
    },
  };
  return { rt, saves };
}

const set = (o: Record<string, unknown>) => ({ theme: '', text_scale: 0, icon_scale: 0, person_asked: true, ...o });

describe('core__appearance', () => {
  it('reads the look any time: the choice, the theme it shows, and (asked) what Settings offers', async () => {
    const { rt } = runtime({ theme: 'dark', text_scale: 1.15, icon_scale: 1 });
    expect(await coreAppearance({ with_offered: true }, rt)).toEqual({
      ok: true,
      result: {
        data: { theme: 'dark', shown: 'dark', text_scale: 1.15, icon_scale: 1, offered: { theme: ['light', 'dark', 'system'], text_scale: [0.9, 1, 1.15, 1.3], icon_scale: [0.85, 1, 1.25, 1.5] }, set_in: LOOK_SET_IN },
        // As Settings labels the sizes: 1.15 is 115%.
        summary: 'dark theme, text 115%, icons 100%',
      },
    });
    const plain = await coreAppearance({ with_offered: false }, rt);
    expect(plain.ok && plain.result.data).not.toHaveProperty('offered');
  });
});

describe('core__set_appearance', () => {
  it('changes nothing unless the person asked for it in this request', async () => {
    const { rt, saves } = runtime();
    expect(await coreSetAppearance(set({ theme: 'dark', person_asked: false }), rt)).toMatchObject({ ok: false, code: 'not_asked', hint: LOOK_SET_IN });
    expect(saves).toEqual([]);
  });

  it('saves only the fields named, as Settings does, and answers the look now', async () => {
    const { rt, saves } = runtime();
    const out = await coreSetAppearance(set({ theme: 'dark', icon_scale: 1.25 }), rt);
    expect(saves).toEqual([{ theme: 'dark', icon_scale: 1.25 }]);
    expect(out).toMatchObject({ ok: true, result: { data: { theme: 'dark', text_scale: 1, icon_scale: 1.25, changed: true }, summary: 'Now dark theme, text 100%, icons 125%' } });
    expect(await coreSetAppearance(set({ text_scale: 1.15 }), rt)).toMatchObject({ ok: true, result: { summary: 'Now dark theme, text 115%, icons 125%' } });
  });

  it('only what Settings offers; nothing named, or nothing different, saves nothing', async () => {
    const { rt, saves } = runtime({ theme: 'dark', text_scale: 1, icon_scale: 1 });
    expect(await coreSetAppearance(set({ theme: 'neon' }), rt)).toMatchObject({ ok: false, code: 'invalid_input', message: 'theme is one of light, dark, system, or "" to keep it.' });
    expect(await coreSetAppearance(set({ text_scale: 2 }), rt)).toMatchObject({ ok: false, code: 'invalid_input', message: 'text_scale is one of 0.9, 1, 1.15, 1.3, or 0 to keep it.' });
    expect(await coreSetAppearance(set({ icon_scale: '1.25' }), rt)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await coreSetAppearance(set({}), rt)).toMatchObject({ ok: false, code: 'invalid_input' });
    expect(await coreSetAppearance(set({ theme: 'dark' }), rt)).toMatchObject({ ok: true, result: { data: { changed: false } } });
    expect(saves).toEqual([]);
  });

  it("a save the app refuses is failed, with the app's reason", async () => {
    const { rt } = runtime(undefined, 'Could not save the look: the app answered 503');
    expect(await coreSetAppearance(set({ theme: 'system' }), rt)).toMatchObject({ ok: false, code: 'failed', message: 'Could not save the look: the app answered 503' });
  });
});
