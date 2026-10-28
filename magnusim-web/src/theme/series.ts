/**
 * Chart series colours on the theme. The core and plugins name a series by its hex (the plugin
 * contract keeps hex: python/cfddesk/registry/contract.py), and the hex stays the series' identity;
 * seriesVar gives the CSS colour that paints it. A series hex is its --mg-series-* token, whose
 * light value is that hex (or, for the three that were under 3:1 on the light plot, a darker one:
 * LIGHT_SERIES), so the dark set reaches it. Any other hex is lifted toward white by
 * --mg-series-lift, which is 0% in light: the light colour is the hex exactly. A saved chart image,
 * drawn with no page CSS, paints a series with seriesLight.
 *
 * SVG presentation attributes do not take var(): set it as a style (stroke, fill, color).
 */

/** Each series hex (lower case) and its token. */
export const SERIES_TOKENS: Readonly<Record<string, string>> = {
  '#1570ef': '--mg-series-1',
  '#6941c6': '--mg-series-2',
  '#12b76a': '--mg-series-3',
  '#f79009': '--mg-series-4',
  '#0ba5ec': '--mg-series-5',
  '#dd2590': '--mg-series-6',
  '#667085': '--mg-series-7',
  '#d92d20': '--mg-series-8',
  '#7a5af8': '--mg-series-9',
  '#0e9384': '--mg-series-10',
  '#dc6803': '--mg-series-11',
  '#3884e6': '--mg-series-default',
};

/**
 * The series whose light value is darker than its hex (Daniel, 2026-10-27): green, orange and light
 * blue were 2.51, 2.24 and 2.64 to 1 on the light plot; these are 3.8 to 1 or more, each still its own hue.
 */
export const LIGHT_SERIES: Readonly<Record<string, string>> = {
  '#12b76a': '#099250',
  '#f79009': '#b54708',
  '#0ba5ec': '#0086c9',
};

/** A series' colour as a light picture paints it (an SVG attribute): its light value, else as given. */
export function seriesLight(color: string): string {
  const c = typeof color === 'string' ? color.trim().toLowerCase() : '';
  return LIGHT_SERIES[c] ?? color;
}

/** A series' colour as CSS: its token, the lifted hex for a hex with no token, else as given. */
export function seriesVar(color: string): string {
  const c = color.trim().toLowerCase();
  if (!/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(c)) return color;
  const hex = c.length === 4 ? `#${[...c.slice(1)].map((d) => d + d).join('')}` : c;
  const token = SERIES_TOKENS[hex];
  return token ? `var(${token})` : `color-mix(in srgb, ${c} calc(100% - var(--mg-series-lift)), white)`;
}
