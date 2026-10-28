/**
 * The Assistant's appearance tools on the core page (coreToolDefs.ts core__appearance and
 * core__set_appearance): what Settings → Appearance shows and does, through the same functions
 * (src/theme/appearance.ts). core__appearance reads the look any time; core__set_appearance changes
 * it only when the person explicitly asked for that change in this request (person_asked; else
 * `not_asked`), and only to what Settings offers. A change is shown at once, in every window, and is
 * the person's to put back in Settings, so it asks no question. That is deliberate: the in-app Yes on
 * every change is the rule for keybinds (keybindTools.ts), where a wrong key can take a command
 * away; a look is seen at once and put back in one click.
 */
import { currentAppearance, ICON_SCALES, resolveTheme, saveAppearance, TEXT_SCALES, THEMES, type Appearance } from '../theme/appearance';
import type { AssistantCallOutcome } from '../workspace/bridge';

type Outcome = AssistantCallOutcome;

const fail = (code: string, message: string, hint?: string): Outcome => ({ ok: false, code, message, ...(hint ? { hint } : {}) });

/** Where the person changes it themselves. */
export const LOOK_SET_IN = 'Settings → Appearance: Theme, Text size and Icon size (Reset to defaults puts light at 100% back).';

/** What the tools reach in the page: injected so the tests drive them without the app. */
export interface LookRuntime {
  current(): Appearance;
  save(patch: Partial<Appearance>): ReturnType<typeof saveAppearance>;
}

export const pageLookRuntime = (): LookRuntime => ({ current: currentAppearance, save: saveAppearance });

/** The look as the tools answer it: the choice, the theme it shows, and (core__appearance) what Settings offers. */
const answer = (a: Appearance, offered = false) => ({
  theme: a.theme,
  shown: resolveTheme(a.theme),
  text_scale: a.text_scale,
  icon_scale: a.icon_scale,
  ...(offered ? { offered: { theme: [...THEMES], text_scale: [...TEXT_SCALES], icon_scale: [...ICON_SCALES] } } : {}),
  set_in: LOOK_SET_IN,
});

/** A size as Settings labels it (1.15 is "115%", not 114.99999999999999). */
const pct = (scale: number) => `${Math.round(scale * 100)}%`;
const lookLine = (a: Appearance) => `${a.theme} theme, text ${pct(a.text_scale)}, icons ${pct(a.icon_scale)}`;

/** core__appearance: the look now, and what Settings offers. */
export async function coreAppearance(rt: LookRuntime): Promise<Outcome> {
  const now = rt.current();
  return { ok: true, result: { data: answer(now, true), summary: lookLine(now) } };
}

/** core__set_appearance: the fields named, as Settings saves them. */
export async function coreSetAppearance(input: Record<string, unknown>, rt: LookRuntime): Promise<Outcome> {
  if (input.person_asked !== true) {
    return fail('not_asked', 'Only change the look when the person explicitly asked for that change in this request; otherwise tell them where to do it.', LOOK_SET_IN);
  }
  const patch: Partial<Appearance> = {};
  if (input.theme !== '' && input.theme != null) {
    if (!(THEMES as readonly unknown[]).includes(input.theme)) return fail('invalid_input', `theme is one of ${THEMES.join(', ')}, or "" to keep it.`);
    patch.theme = input.theme as Appearance['theme'];
  }
  for (const [key, list] of [
    ['text_scale', TEXT_SCALES],
    ['icon_scale', ICON_SCALES],
  ] as const) {
    const v = input[key];
    if (v === 0 || v == null) continue;
    if (typeof v !== 'number' || !list.includes(v)) return fail('invalid_input', `${key} is one of ${list.join(', ')}, or 0 to keep it.`);
    patch[key] = v;
  }
  if (!Object.keys(patch).length) return fail('invalid_input', 'Name what to change: theme, text_scale or icon_scale.');
  const now = rt.current();
  if (Object.entries(patch).every(([k, v]) => now[k as keyof Appearance] === v)) {
    return { ok: true, result: { data: { ...answer(now), changed: false }, summary: 'The look is that already' } };
  }
  const out = await rt.save(patch);
  if (!out.ok) return fail('failed', out.error);
  return { ok: true, result: { data: { ...answer(out.appearance), changed: true }, summary: `Now ${lookLine(out.appearance)}` } };
}
