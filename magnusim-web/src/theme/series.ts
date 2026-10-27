/**
 * Chart series colours on the theme. The core and plugins name a series by its hex (the plugin
 * contract keeps hex: python/cfddesk/registry/contract.py), and the hex stays the series' identity;
 * seriesVar gives the CSS colour that paints it. A series hex is its --mg-series-* token, whose
 * light value is that hex, so the dark set reaches it. Any other hex is lifted toward white by
 * --mg-series-lift, which is 0% in light: the light colour is the hex exactly.
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

/** A series' colour as CSS: its token, the lifted hex for a hex with no token, else as given. */
export function seriesVar(color: string): string {
  const c = color.trim().toLowerCase();
  if (!/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.test(c)) return color;
  const hex = c.length === 4 ? `#${[...c.slice(1)].map((d) => d + d).join('')}` : c;
  const token = SERIES_TOKENS[hex];
  return token ? `var(${token})` : `color-mix(in srgb, ${c} calc(100% - var(--mg-series-lift)), white)`;
}
