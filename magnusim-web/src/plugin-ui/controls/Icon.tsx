export type IconName = 'pencil' | 'trash' | 'back' | 'document';

// The core's own stroke icons, copied (RenameTitle, LeftTree, WorkspaceOverlay).
const PATHS: Readonly<Record<IconName, readonly string[]>> = Object.freeze({
  pencil: ['M4 16.8V20h3.2L18.4 8.8l-3.2-3.2L4 16.8z', 'M13.8 6.9l3.2 3.2'],
  trash: ['M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13'],
  back: ['M15 5l-7 7 7 7'],
  document: ['M5 4h10l4 4v12H5z M15 4v4h4'],
});

export interface IconProps {
  /** One of the core's icons. Give exactly one of name or path. */
  name?: IconName;
  /** An SVG path (`d`) in a 24 x 24 box. */
  path?: string;
  /** Default 15. */
  size?: 13 | 14 | 15 | 16 | 18;
  /** Default 1.8. */
  stroke?: 1.7 | 1.8;
  /** Read out by screen readers; without it the icon is hidden from them. */
  title?: string;
}

/** A stroke icon in the colour of its text. */
export function Icon({ name, path, size = 15, stroke = 1.8, title }: IconProps) {
  if (!name === !path) throw new Error('Icon takes exactly one of name or path');
  let paths: readonly string[];
  if (name) {
    if (!Object.prototype.hasOwnProperty.call(PATHS, name)) throw new Error(`Icon has no icon named ${String(name)}`);
    paths = PATHS[name];
  } else {
    paths = [String(path)];
  }
  return (
    <svg
      className="mgk-icon"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      focusable="false"
      aria-hidden={title ? undefined : 'true'}
    >
      {title ? <title>{title}</title> : null}
      <g fill="none" stroke="currentColor" strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round">
        {paths.map((d) => (
          <path key={d} d={d} />
        ))}
      </g>
    </svg>
  );
}
